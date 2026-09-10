/**
 * The confidential-token side: Zama's already-deployed ERC-7984 tokens.
 *
 * zilch conceals the amount with a confidential token, and to stay contract-free
 * it drives tokens Zama has already deployed on Sepolia — by default the official
 * cUSDC wrapper (`ERC7984ERC20Wrapper`) over a mock USDC whose `mint` is public,
 * so a fresh wallet can fund itself, wrap into a confidential balance, and send
 * it — no deployment of our own. The ABIs live here on the server (the browser
 * ships none); this module reads token metadata and builds the calldata the
 * wallet signs. The encryption itself never happens here — the browser produces
 * the ciphertext handle and input proof with Zama's SDK and hands them in.
 *
 * The default token and its underlying are overridable by environment variable
 * to point at any ERC-7984 wrapper that follows the same interface.
 */

import { encodeFunctionData } from "viem";
import type { TokenPair, Tx, TxRequest } from "../shared/types.js";
import { CHAIN_ID, client } from "./chain.js";

/** Zama's official Sepolia cUSDC wrapper and its public-mint mock USDC. */
const DEFAULT_CTOKEN = (process.env.ZILCH_CTOKEN ??
  "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639") as `0x${string}`;
const DEFAULT_UNDERLYING = (process.env.ZILCH_UNDERLYING ??
  "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF") as `0x${string}`;
const DEFAULT_SYMBOL = process.env.ZILCH_TOKEN_SYMBOL ?? "cUSDC";
const DEFAULT_UNDERLYING_SYMBOL = process.env.ZILCH_UNDERLYING_SYMBOL ?? "USDC";
const DEFAULT_DECIMALS = Number(process.env.ZILCH_TOKEN_DECIMALS ?? "6");

/** The single confidential-token pairing the template ships with. Returned as a
 *  list so the shape generalises to a registry-driven set later. */
export function listTokens(): { registry: string; tokens: TokenPair[] } {
  return {
    registry: "none (direct token)",
    tokens: [
      {
        symbol: DEFAULT_SYMBOL,
        confidentialToken: DEFAULT_CTOKEN,
        underlying: DEFAULT_UNDERLYING,
        underlyingSymbol: DEFAULT_UNDERLYING_SYMBOL,
        decimals: DEFAULT_DECIMALS,
        hasFaucet: true,
      },
    ],
  };
}

/** Resolve a confidential-token address to its underlying ERC-20. Known for the
 *  default token; for any other, the caller passes the underlying explicitly. */
function underlyingOf(cToken: string): `0x${string}` {
  if (cToken.toLowerCase() === DEFAULT_CTOKEN.toLowerCase()) {
    return DEFAULT_UNDERLYING;
  }
  throw new InvalidTx(
    "unknown confidential token — configure ZILCH_CTOKEN / ZILCH_UNDERLYING",
  );
}

/** A malformed transaction request. The route maps this to `400`. */
export class InvalidTx extends Error {}

const ERC20_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC7984_ABI = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    // the input-proof transfer variant: externalEuint64 handle + proof
    type: "function",
    name: "confidentialTransfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/**
 * Build one confidential-token transaction. `faucet` mints the underlying mock
 * to the caller; `approve` lets the wrapper pull the underlying; `wrap` mints the
 * confidential balance; `send` performs the ERC-7984 confidential transfer using
 * the Zama-produced handle and proof. None of these is payable.
 */
export function buildTokenTx(req: TxRequest): Tx {
  const from = requireAddress(req.from, "from");
  const cToken = requireAddress(req.token, "token");

  if (req.kind === "faucet") {
    const amount = requireAmount(req.amount);
    return wrap(
      underlyingOf(cToken),
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "mint",
        args: [from, amount],
      }),
    );
  }
  if (req.kind === "approve") {
    const amount = requireAmount(req.amount);
    return wrap(
      underlyingOf(cToken),
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [cToken, amount],
      }),
    );
  }
  if (req.kind === "wrap") {
    const amount = requireAmount(req.amount);
    return wrap(
      cToken,
      encodeFunctionData({
        abi: ERC7984_ABI,
        functionName: "wrap",
        args: [from, amount],
      }),
    );
  }
  // send
  const recipient = requireAddress(req.recipient, "recipient");
  if (!isHex(req.handle) || !isHex(req.inputProof)) {
    throw new InvalidTx("send requires the Zama handle and inputProof");
  }
  return wrap(
    cToken,
    encodeFunctionData({
      abi: ERC7984_ABI,
      functionName: "confidentialTransfer",
      args: [
        recipient,
        req.handle as `0x${string}`,
        req.inputProof as `0x${string}`,
      ],
    }),
  );
}

/* ---- helpers ---- */

const ERC7984_READ_ABI = [
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** Read an account's confidential balance handle (a `bytes32` ciphertext handle)
 *  for one token. The browser then user-decrypts it with an EIP-712 permit. */
export async function readBalanceHandle(
  token: string,
  account: string,
): Promise<string> {
  const cToken = requireAddress(token, "token");
  const holder = requireAddress(account, "account");
  const pub = client();
  const handle = await pub.readContract({
    address: cToken,
    abi: ERC7984_READ_ABI,
    functionName: "confidentialBalanceOf",
    args: [holder],
  });
  return handle as string;
}

function wrap(to: `0x${string}`, data: `0x${string}`): Tx {
  return { to, data, value: "0x0", chainId: CHAIN_ID };
}

function requireAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value as `0x${string}`;
  }
  throw new InvalidTx(`${label} must be an address`);
}

function requireAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new InvalidTx("amount must be a base-unit integer string");
  }
  return BigInt(value);
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
