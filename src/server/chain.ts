/**
 * Server-side chain access for the `/api` routes.
 *
 * Every use of `@nillion/blacklight-l1-sdk` and `viem` is confined to the server,
 * for two reasons the project depends on: the SDK's event-reading, reconstruction,
 * and price surfaces are Node-only by design, and keeping them here means the
 * browser bundle ships no contract ABIs and no crypto — the client only ever reads
 * JSON from these routes and talks to the user's wallet. This module owns the viem
 * client, the address set resolved off C0, the number formatting (delegated to the
 * SDK so the wire's display strings match the chain's semantics), and the bounded
 * log scans the feed and detail views run.
 */

import {
  ASSETS_V1,
  ASSETS_V2,
  formatNil,
  formatPrice1e8,
  protocolConfigAbi,
  resolveAddresses,
  triggerMarketAbi,
} from "@nillion/blacklight-l1-sdk";
import {
  type AbiEvent,
  type Chain,
  createPublicClient,
  formatEther,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { sepolia } from "viem/chains";

export { protocolConfigAbi, triggerMarketAbi };

/** C0 — the `ProtocolConfig` proxy, the one address an integration pins. Every
 *  other module address is resolved off it at runtime, so a superseded deployment
 *  can never be served from a stale address file. Overridable only to follow a
 *  future redeploy. */
export const C0 =
  process.env.BLACKLIGHT_CONFIG ?? "0xebB338689fB32317DDFD8282F8a42dcA6271cB2d";

/** Sepolia. */
export const CHAIN_ID = 11155111;

/** `HOOK_ACK == bytes4(keccak256("onReveal(uint256,bytes)"))`. A settlement hook
 *  returns this to acknowledge a reveal; anything else means it declined. */
export const HOOK_ACK = "0xd8e071b6";

/** A public Sepolia endpoint by default; point at a paid/authenticated provider
 *  with `SEPOLIA_RPC_URL`. Server-side only, so no CORS and no exposed key. */
const RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

/** How far back the `TriggerPosted`/`SharePosted` scans look. The SDK's liveness
 *  note puts ~1,800 blocks inside every surveyed provider's `eth_getLogs` cap;
 *  5,000 (~17h) is a comfortable default, and {@link marketLogs} falls back to
 *  1,800 if a provider rejects the range. Covenant discovery itself uses
 *  `nextTriggerId` + `triggerMeta` and does not depend on this window. */
export const SCAN_BLOCKS = BigInt(process.env.SCAN_BLOCKS ?? "5000");
const SCAN_BLOCKS_FALLBACK = 1800n;

let cachedClient: PublicClient<Transport, Chain> | null = null;

/** The shared viem public client, created lazily and reused across warm
 *  invocations. Typed with concrete generics so viem's client type does not
 *  deep-instantiate under the serverless builder's stricter module resolution. */
export function client(): PublicClient<Transport, Chain> {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: sepolia,
      transport: http(RPC_URL, { batch: true }),
    });
  }
  return cachedClient;
}

type AddressSet = Awaited<ReturnType<typeof resolveAddresses>>;
let cachedAddresses: AddressSet | null = null;

/**
 * Resolve the module set off C0, caching the result across warm invocations.
 *
 * `resolveAddresses` throws when C0 holds no wired deployment rather than
 * returning zero addresses, so a successful call is exactly the "you are on the
 * live deployment" guarantee the config route reports. The cache is populated
 * only on success, so a transient RPC failure is retried on the next call rather
 * than sticking.
 */
export async function addresses(): Promise<AddressSet> {
  if (!cachedAddresses) {
    cachedAddresses = await resolveAddresses(client(), C0 as `0x${string}`);
  }
  return cachedAddresses;
}

/** The merged asset table (`ASSETS_V1 ∪ ASSETS_V2`); ids are append-only, so a
 *  union resolves every shipped id. Returns a synthetic label for an unknown id
 *  rather than throwing. */
const ASSET_BY_ID: Record<number, string> = (() => {
  const table: Record<number, string> = {};
  for (const [name, id] of Object.entries({ ...ASSETS_V1, ...ASSETS_V2 })) {
    table[id as number] = name;
  }
  return table;
})();

export function assetName(id: number | bigint): string {
  return ASSET_BY_ID[Number(id)] ?? `asset#${id}`;
}

/** Format wei as an ether decimal string, or `null` for a missing value. */
export function formatEth(
  wei: bigint | string | null | undefined,
): string | null {
  return wei === null || wei === undefined ? null : formatEther(BigInt(wei));
}

/** Format raw 6-decimal NIL units as a decimal string, or `null`. */
export function formatNilDisplay(
  raw: bigint | string | null | undefined,
): string | null {
  return raw === null || raw === undefined ? null : formatNil(BigInt(raw));
}

/** Format raw 10^-8 USD units as an exact decimal string, or `null`. */
export function formatPriceDisplay(
  raw: bigint | string | null | undefined,
): string | null {
  return raw === null || raw === undefined ? null : formatPrice1e8(BigInt(raw));
}

/** A `TriggerMarket` log, narrowed to the fields the routes read. */
export interface MarketLog {
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
}

/**
 * Scan a `TriggerMarket` event over the recent window, with a range fallback.
 *
 * Providers cap `eth_getLogs` block ranges inconsistently, so a rejected wide
 * scan is retried at the narrower {@link SCAN_BLOCKS_FALLBACK}. The optional
 * `args` filter by an indexed parameter (e.g. a single `triggerId`).
 */
export async function marketLogs(
  eventName: string,
  args?: Record<string, unknown>,
): Promise<MarketLog[]> {
  const pub = client();
  const market = (await addresses()).market;
  const event = triggerMarketAbi.find(
    (fragment) => fragment.type === "event" && fragment.name === eventName,
  ) as AbiEvent;
  const latest = await pub.getBlockNumber();

  const scan = async (span: bigint): Promise<MarketLog[]> => {
    const fromBlock = latest > span ? latest - span : 0n;
    const logs = await pub.getLogs({
      address: market,
      event,
      args: args as never,
      fromBlock,
      toBlock: latest,
    });
    return logs as unknown as MarketLog[];
  };

  try {
    return await scan(SCAN_BLOCKS);
  } catch {
    return await scan(SCAN_BLOCKS_FALLBACK);
  }
}

/**
 * Normalize a contract read that returns multiple values. viem yields these
 * positionally for a function with several outputs but as an object for a struct;
 * this reads either shape by index or by name so a route need not know which.
 */
export function pick<T = unknown>(
  result: unknown,
  index: number,
  name: string,
): T {
  if (Array.isArray(result)) {
    return result[index] as T;
  }
  if (result && typeof result === "object" && name in result) {
    return (result as Record<string, unknown>)[name] as T;
  }
  return undefined as T;
}
