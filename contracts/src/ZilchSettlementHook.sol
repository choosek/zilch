// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZamaMultiChainConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * @title  ZilchSettlementHook
 * @notice The contract that turns zilch's two loosely-coupled halves into one
 *         atomic action. Without it, a Covenant reveal only *makes the transfer
 *         instruction visible*; the confidential cUSDC transfer is then a
 *         separate, manual step, bound to the reveal by nothing but the app's
 *         own logic. With it, the confidential amount is escrowed here when the
 *         transfer is sealed and released to the sealed recipient *inside the
 *         reveal transaction itself* — so the payment happens if and only if the
 *         Covenant opens, for the escrowed (still-encrypted) amount, to the
 *         sealed recipient, enforced on-chain.
 *
 * @dev    Lifecycle:
 *
 *         1. SEAL / ESCROW (sender, off the Covenant):
 *            a. `IERC7984(token).setOperator(address(this), until)` — let this
 *               contract move the sender's confidential balance.
 *            b. `createSealedTransfer(id, token, recipient, encAmount, proof)` —
 *               `encAmount` is a fresh input encrypted for THIS contract
 *               (`createEncryptedInput(hook, sender).add64(amount)`). The hook
 *               pulls the confidential amount into itself and records it under a
 *               caller-chosen unique `id`.
 *            c. The sender posts the Covenant with `hook = address(this)` and a
 *               sealed instruction whose fixed-offset prefix carries the same
 *               `id`, `recipient`, and `token` (zilch's `ZILCH1` encoding).
 *
 *         2. OPEN / RELEASE (Blacklight committee, in the reveal tx):
 *            When the trigger fires, the TriggerMarket's `post_result` invokes
 *            {onReveal} with the revealed plaintext. The hook decodes the
 *            instruction, matches it to the escrow, and `confidentialTransfer`s
 *            the held encrypted amount to the recipient — atomically.
 *
 *         3. EXPIRE / REFUND (sender):
 *            If the Covenant expires untriggered, the sender calls {refund} to
 *            reclaim the escrowed amount.
 *
 * @dev    UNAUDITED REFERENCE CONTRACT. It is written against the real
 *         fhevm/solidity ^0.13 and openzeppelin/confidential-contracts
 *         interfaces, but it has NOT been compiled against a live FHEVM
 *         toolchain, deployed, or tested on-chain, and two integration points
 *         must be verified before production use:
 *
 *         - The Blacklight hook ABI. This assumes the market calls
 *           `onReveal(uint256 triggerId, bytes plaintext)` and expects the
 *           return of `HOOK_ACK == bytes4(keccak256("onReveal(uint256,bytes)"))`,
 *           and that `plaintext` begins with the sealed payload (any trailing
 *           nonce is ignored because the fields read here are at a fixed prefix).
 *           Confirm against the Blacklight SDK/docs and adjust if needed.
 *         - The ERC-7984 ACL semantics. Holding a confidential balance across
 *           transactions and re-transferring it relies on `FHE.allowThis` giving
 *           this contract persistent access to the escrowed handle. Verify the
 *           escrow/release/refund round-trip on a testnet.
 */
contract ZilchSettlementHook is ZamaMultiChainConfig {
    /// @dev `bytes4(keccak256("onReveal(uint256,bytes)"))` — returned to
    ///      acknowledge a reveal to the TriggerMarket.
    bytes4 private constant HOOK_ACK = 0xd8e071b6;

    /// @dev Minimum length of a `ZILCH1` instruction prefix:
    ///      6 (magic) + 1 (flags) + 20 (recipient) + 20 (token) + 32 (id).
    uint256 private constant PREFIX_LEN = 79;

    /// @notice The Blacklight `TriggerMarket` permitted to invoke {onReveal}.
    address public immutable market;

    enum State {
        None,
        Escrowed,
        Released,
        Refunded
    }

    struct Escrow {
        address token; // the ERC-7984 confidential token
        address sender; // who escrowed (and may refund)
        address recipient; // who is paid on reveal
        euint64 amount; // the held encrypted amount
        State state;
    }

    mapping(bytes32 id => Escrow) private _escrows;

    event Escrowed(
        bytes32 indexed id,
        address indexed sender,
        address indexed recipient,
        address token
    );
    event Released(
        bytes32 indexed id,
        uint256 indexed triggerId,
        address indexed recipient
    );
    event Refunded(bytes32 indexed id, address indexed sender);

    error NotMarket();
    error BadState();
    error NotSender();
    error WrongInstruction();
    error TooShort();

    constructor(address market_) {
        market = market_;
    }

    /**
     * @notice Escrow a confidential amount for a future sealed transfer.
     * @dev The caller must first approve this contract as an ERC-7984 operator
     *      (`setOperator`). `encryptedAmount` must be encrypted for THIS contract
     *      and the caller. Reverts if `id` is already used.
     */
    function createSealedTransfer(
        bytes32 id,
        address token,
        address recipient,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external {
        if (_escrows[id].state != State.None) revert BadState();

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        // Pull the confidential amount from the sender into this contract. The
        // returned handle is the amount actually moved; keep persistent ACL so it
        // can be transferred again in the (later) reveal or refund transaction.
        euint64 held = IERC7984(token).confidentialTransferFrom(
            msg.sender,
            address(this),
            amount
        );
        FHE.allowThis(held);

        _escrows[id] = Escrow({
            token: token,
            sender: msg.sender,
            recipient: recipient,
            amount: held,
            state: State.Escrowed
        });
        emit Escrowed(id, msg.sender, recipient, token);
    }

    /**
     * @notice Invoked by the TriggerMarket in the reveal transaction. Decodes the
     *         revealed instruction, matches it to the escrow, and releases the
     *         held encrypted amount to the sealed recipient.
     * @return HOOK_ACK on success, to acknowledge the reveal.
     */
    function onReveal(
        uint256 triggerId,
        bytes calldata plaintext
    ) external returns (bytes4) {
        if (msg.sender != market) revert NotMarket();

        (address recipient, address token, bytes32 id) = _decodeInstruction(
            plaintext
        );

        Escrow storage e = _escrows[id];
        if (e.state != State.Escrowed) revert BadState();
        if (e.recipient != recipient || e.token != token) {
            revert WrongInstruction();
        }

        e.state = State.Released;
        IERC7984(token).confidentialTransfer(recipient, e.amount);
        emit Released(id, triggerId, recipient);
        return HOOK_ACK;
    }

    /**
     * @notice Reclaim an escrow whose Covenant expired without triggering. Only
     *         the original sender may refund, and only while still escrowed.
     */
    function refund(bytes32 id) external {
        Escrow storage e = _escrows[id];
        if (e.state != State.Escrowed) revert BadState();
        if (e.sender != msg.sender) revert NotSender();

        e.state = State.Refunded;
        IERC7984(e.token).confidentialTransfer(e.sender, e.amount);
        emit Refunded(id, msg.sender);
    }

    /// @notice The lifecycle state of an escrow (0 none, 1 escrowed, 2 released,
    ///         3 refunded).
    function escrowState(bytes32 id) external view returns (State) {
        return _escrows[id].state;
    }

    /**
     * @dev Decode the fixed-offset prefix of a `ZILCH1` instruction. Layout:
     *      "ZILCH1"(6) | flags(1) | recipient(20) | token(20) | id(32) | memo...
     *      Any trailing bytes (memo, and a nonce the committee may append) are
     *      ignored, since every field needed here is at a fixed position.
     */
    function _decodeInstruction(
        bytes calldata p
    ) private pure returns (address recipient, address token, bytes32 id) {
        if (p.length < PREFIX_LEN) revert TooShort();
        if (bytes6(p[0:6]) != bytes6("ZILCH1")) revert WrongInstruction();
        recipient = address(bytes20(p[7:27]));
        token = address(bytes20(p[27:47]));
        id = bytes32(p[47:79]);
    }
}
