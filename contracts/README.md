# zilch Settlement Hook

`ZilchSettlementHook` is the optional contract that turns zilch's two loosely-coupled halves into **one atomic action**. It is the honest upgrade the main README describes: without it, a Covenant reveal only makes the transfer *instruction* visible, and the confidential token transfer is a separate manual step bound to the reveal by nothing but the app's own logic. With it, the confidential amount is escrowed when the transfer is sealed and released to the sealed recipient **inside the reveal transaction itself**.

## What It Binds

| Property | Without the hook | With the hook |
| --- | --- | --- |
| Does reveal cause the payment? | No, a manual separate tx | **Yes, atomic, in the reveal tx** |
| Recipient of the transfer | App passes it at settle time | **Fixed by the sealed instruction** |
| Amount transferred | Chosen client-side at settle | **Fixed by the escrow, still encrypted** |
| Enforced by | App convention | **The contract** |

The amount never appears in plaintext: it is escrowed as an encrypted `euint64` and the *same* handle is released, so it stays confidential throughout.

## Lifecycle

1. **Seal / escrow** (sender, off the Covenant)
   - `IERC7984(cToken).setOperator(hook, until)` authorises the hook to move the sender's confidential balance.
   - `hook.createSealedTransfer(id, cToken, recipient, encAmount, proof)`, where `encAmount` is a fresh input encrypted **for the hook** (`createEncryptedInput(hook, sender).add64(amount)`). The hook pulls the confidential amount into itself and records it under a caller-chosen unique `id`.
   - The sender posts the Covenant with `hook = <address>` and a sealed instruction whose fixed-offset prefix carries the same `id`, `recipient`, and `token`.
2. **Open / release** (Blacklight committee, in the reveal tx)
   - When the trigger fires, the `TriggerMarket`'s `postResult` invokes `onReveal(triggerId, plaintext)`. The hook decodes the instruction, matches it to the escrow, and `confidentialTransfer`s the held encrypted amount to the recipient, atomically, returning `HOOK_ACK`.
3. **Expire / refund** (sender)
   - If the Covenant expires untriggered, the sender calls `refund(id)` to reclaim the escrowed amount.

The instruction prefix the hook decodes (zilch's `ZILCH1` encoding) is:
```
"ZILCH1"(6) | flags(1) | recipient(20) | token(20) | id(32) | memo…(| nonce)
```
Only the fixed-position fields (`recipient`, `token`, `id`) are read; any trailing memo and any nonce the committee appends are ignored.

## Deploy

**Via the dashboard (recommended).** Open the app at `?view=deploy` (linked from the footer as "settlement hook"). Connect a wallet on Ethereum mainnet, confirm the `TriggerMarket` address shown as the constructor argument, and deploy. The page then validates the address on-chain and generates the environment configuration.

**Via CLI.** The compiled creation bytecode and ABI live in `src/client/hookArtifact.ts`. Deploy them with any tool, for example a short viem script, passing the `TriggerMarket` address as the sole constructor argument. You can read the current market address from `GET /api/config`.

## Recompile

If you edit `src/ZilchSettlementHook.sol`, regenerate the artifact:
```
node contracts/compile.mjs
```
This compiles with solc 0.8.28 (evmVersion cancun, optimizer 200), resolving `@fhevm/solidity`, `@openzeppelin/confidential-contracts`, and `encrypted-types` from `node_modules`, and rewrites `src/client/hookArtifact.ts`. Foundry or Hardhat with the FHEVM plugins also work and are recommended for writing and running on-chain tests.

## Configure

Set the deployed address (the dashboard generates this for you):
```
ZILCH_HOOK=0x…
# Optional: gas budget for the reveal-time hook call (default 3000000).
# ZILCH_HOOK_GAS=3000000
```
`GET /api/config` reports `{ chainId, market, hook, atomic }`; `atomic` is true once `ZILCH_HOOK` is set. On the server, `postTrigger` wires the hook into the Covenant **only** when the client opts in (`useHook`) *and* `ZILCH_HOOK` is a valid address, so setting the variable cannot half-activate the feature and break reveals before the client flow below is in place.

## Trust Model & Caveats

- **Unaudited.** No security review. The escrow holds real confidential balances; a bug can lock or misdirect them.
- **Operator requirement.** `createSealedTransfer` pulls funds via `confidentialTransferFrom`, so the sender must `setOperator(hook, …)` first.
- **`id` uniqueness.** Post exactly one Covenant per `id`. An escrow is claimed once; a second reveal for the same `id` reverts (no double-spend), but reusing ids across Covenants is a configuration error.
- **Gas.** The reveal-time `confidentialTransfer` is FHE-heavy. Size `ZILCH_HOOK_GAS` (and confirm how the market meters `hookGasLimit`) generously, or the release can run out of gas inside the reveal.

## Client Escrow & Auto-Settle

When `GET /api/config` reports `atomic: true`, the client should:

1. **Compose / seal.** Generate a random 32-byte `id`. Call `IERC7984(cToken).setOperator(hook, until)`. Encrypt the amount **for the hook** with the v3 SDK's low-level `encrypt` (not the wrapped-token helper, which encrypts for the token), then call `hook.createSealedTransfer(id, cToken, recipient, encAmount, proof)`. Post the Covenant with `useHook: true` and `amountCommitment: id` (the existing seal request fields), so the sealed instruction carries `id` in the commit slot and the server wires the hook.
2. **Detail / settle.** In atomic mode the transfer releases automatically on reveal, so replace the manual "Settle" action with the escrow state (`hook.escrowState(id)`) and an "auto-settles on reveal" note, plus a `refund(id)` control once the Covenant has expired.

The manual flow is the fallback when no hook is configured.
