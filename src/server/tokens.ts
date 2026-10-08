/**
 * The confidential-token configuration.
 *
 * zilch conceals the amount with Zama's ERC-7984 confidential tokens. Rather than
 * pin a single pairing, it discovers what is actually registered on-chain: the
 * Zama **wrappers registry** maps each plain ERC-20 to its confidential wrapper,
 * so this module reads that registry (its address comes from the SDK's chain
 * preset) and returns the live, valid pairs with their symbols and decimals. The
 * browser then drives the token operations directly with Zama's v3 SDK (shield,
 * confidential transfer, decrypt), so no ABIs or calldata for those live here.
 *
 * There is no faucet on mainnet — a balance is funded by wrapping real underlying
 * tokens, not minting a mock — so every discovered pair reports `hasFaucet: false`.
 *
 * Overrides, both optional: `ZILCH_REGISTRY` points at a different registry, and
 * `ZILCH_CTOKEN` + `ZILCH_UNDERLYING` pin one specific pair and skip discovery.
 */

import { mainnet } from "@zama-fhe/sdk/chains";
import type { TokenPair, TokensResponse } from "../shared/types.js";
import { client } from "./chain.js";

const REGISTRY = (process.env.ZILCH_REGISTRY ??
  mainnet.registryAddress) as `0x${string}`;

/** How many registry entries to surface. Discovery reads one bounded slice. */
const MAX_TOKENS = Number(process.env.ZILCH_MAX_TOKENS ?? "24");

/** The two registry reads discovery needs: the pair count and a slice of pairs. */
const registryAbi = [
  {
    type: "function",
    name: "getTokenConfidentialTokenPairsLength",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getTokenConfidentialTokenPairsSlice",
    stateMutability: "view",
    inputs: [
      { name: "fromIndex", type: "uint256" },
      { name: "toIndex", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "tokenAddress", type: "address" },
          { name: "confidentialTokenAddress", type: "address" },
          { name: "isValid", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** Standard ERC-20 / ERC-7984 metadata reads for display. */
const metaAbi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

interface RegistryPair {
  tokenAddress: `0x${string}`;
  confidentialTokenAddress: `0x${string}`;
  isValid: boolean;
}

/** Read a confidential token's symbol + decimals and its underlying's symbol,
 *  tolerating a token that omits a metadata view. */
async function describe(pair: RegistryPair): Promise<TokenPair> {
  const pub = client();
  const [confidentialSymbol, decimals, underlyingSymbol] = await Promise.all([
    pub
      .readContract({
        address: pair.confidentialTokenAddress,
        abi: metaAbi,
        functionName: "symbol",
      })
      .catch(() => "cTOKEN"),
    pub
      .readContract({
        address: pair.confidentialTokenAddress,
        abi: metaAbi,
        functionName: "decimals",
      })
      .catch(() => 6),
    pub
      .readContract({
        address: pair.tokenAddress,
        abi: metaAbi,
        functionName: "symbol",
      })
      .catch(() => "TOKEN"),
  ]);
  return {
    symbol: String(confidentialSymbol),
    confidentialToken: pair.confidentialTokenAddress,
    underlying: pair.tokenAddress,
    underlyingSymbol: String(underlyingSymbol),
    decimals: Number(decimals),
    hasFaucet: false,
  };
}

/** Discover the registered confidential tokens, or honor an env-pinned pair. */
async function discover(): Promise<TokenPair[]> {
  const pub = client();

  const pinnedConfidential = process.env.ZILCH_CTOKEN;
  const pinnedUnderlying = process.env.ZILCH_UNDERLYING;
  if (pinnedConfidential && pinnedUnderlying) {
    return [
      await describe({
        tokenAddress: pinnedUnderlying as `0x${string}`,
        confidentialTokenAddress: pinnedConfidential as `0x${string}`,
        isValid: true,
      }),
    ];
  }

  const total = Number(
    await pub.readContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: "getTokenConfidentialTokenPairsLength",
    }),
  );
  if (total === 0) {
    return [];
  }
  const slice = (await pub.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "getTokenConfidentialTokenPairsSlice",
    args: [0n, BigInt(Math.min(total, MAX_TOKENS))],
  })) as readonly RegistryPair[];

  return Promise.all(slice.filter((pair) => pair.isValid).map(describe));
}

let cache: TokensResponse | null = null;

/**
 * The confidential tokens zilch can use, discovered from the on-chain registry
 * and cached across warm invocations. The cache is populated only on success, so
 * a transient RPC failure is retried on the next call.
 */
export async function listTokens(): Promise<TokensResponse> {
  if (!cache) {
    cache = { registry: REGISTRY, tokens: await discover() };
  }
  return cache;
}
