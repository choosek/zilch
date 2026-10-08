/**
 * Reading covenants as sealed transfers.
 *
 * This is zilch's read half: it turns the `TriggerMarket`'s covenants into
 * sealed transfers without persisting anything. An outcome is derived on the fly
 * from what the chain already exposes — the post log (author, public trigger,
 * when it was sealed), the meta (resolution, expiry, committee size), and, once
 * a transfer opens, the `TriggerResolved` event, whose plaintext lets the sealed
 * instruction be read straight from the log. The amount is never among these
 * facts; it lives only in Zama's ciphertext. The pure parts — the outcome and
 * the instruction codec — live in `src/core`; this module only gathers facts.
 */

import {
  fetchCandidates,
  hexToBytes,
  NONCE_BYTES,
} from "@nillion/covenants-sdk";
import type { PublicClient } from "viem";
import { decodeInstruction } from "../core/instruction.js";
import { transferOutcome } from "../core/transfer.js";
import type {
  CommitteeSlot,
  FeedResponse,
  Instruction,
  SealedTransfer,
  TimelineEntry,
  TransferDetail,
} from "../shared/types.js";
import {
  addresses,
  client,
  type MarketLog,
  marketLogs,
  pick,
  triggerMarketAbi,
} from "./chain.js";
import { decodeCondition } from "./decode.js";
import { listTokens } from "./tokens.js";

/** Asset name → id, for the optional spot read on a detail view. */
const ASSET_IDS: Record<string, number> = {
  BTC: 1,
  ETH: 2,
  SOL: 3,
  USDT: 6,
};

/** A covenant's meta, read positionally from `triggerMeta`. */
interface Meta {
  mode: number;
  k: number;
  m: number;
  expiry: number;
  t1: number;
  t2: number;
  commit: string;
  resolved: boolean;
}

async function readMeta(pub: PublicClient, id: bigint): Promise<Meta> {
  const market = (await addresses()).market;
  const r = await pub.readContract({
    address: market,
    abi: triggerMarketAbi,
    functionName: "triggerMeta",
    args: [id],
  });
  return {
    mode: Number(pick<bigint>(r, 0, "mode")),
    k: Number(pick<bigint>(r, 1, "k")),
    m: Number(pick<bigint>(r, 2, "m")),
    expiry: Number(pick<bigint>(r, 3, "expiry")),
    t1: Number(pick<bigint>(r, 4, "t1")),
    t2: Number(pick<bigint>(r, 5, "t2")),
    commit: pick<string>(r, 6, "commit"),
    resolved: pick<boolean>(r, 8, "resolved"),
  };
}

/** Fetch the timestamps of a set of blocks in one pass, deduplicated. */
async function blockTimes(
  pub: PublicClient,
  blocks: Iterable<bigint>,
): Promise<Map<string, number>> {
  const unique = [...new Set([...blocks].map((b) => b.toString()))];
  const times = new Map<string, number>();
  await Promise.all(
    unique.map(async (key) => {
      const block = await pub.getBlock({ blockNumber: BigInt(key) });
      times.set(key, Number(block.timestamp));
    }),
  );
  return times;
}

/** The current chain time — the latest block's timestamp. */
async function chainNow(pub: PublicClient): Promise<number> {
  const block = await pub.getBlock();
  return Number(block.timestamp);
}

/** token address → confidential symbol, from the configured token set. */
async function symbolByToken(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const token of (await listTokens()).tokens) {
    map.set(token.confidentialToken.toLowerCase(), token.symbol);
  }
  return map;
}

/**
 * Decode an opened transfer's instruction from its resolution plaintext, which
 * is `payload ‖ nonce` — the trailing 32-byte nonce is stripped first. Returns
 * null when the payload is not a zilch instruction. The confidential-token
 * symbol is resolved from the configured set.
 */
function instructionFromPlaintext(
  plaintextHex: string,
  symbols: Map<string, string>,
): Instruction | null {
  const full = hexToBytes(plaintextHex as `0x${string}`);
  const payload =
    full.length > NONCE_BYTES ? full.slice(0, full.length - NONCE_BYTES) : full;
  const instruction = decodeInstruction(payload);
  if (instruction) {
    instruction.tokenSymbol =
      symbols.get(instruction.token.toLowerCase()) ?? null;
  }
  return instruction;
}

/**
 * `GET /api/feed`: the most recent sealed transfers, newest first, with a live
 * tally. Each is sourced from a `TriggerPosted` log, enriched with its meta and,
 * once open, its revealed instruction.
 */
export async function readFeed(limit: number): Promise<FeedResponse> {
  const pub = client();
  const [posted, resolvedLogs, shareLogs, now] = await Promise.all([
    marketLogs("TriggerPosted"),
    marketLogs("TriggerResolved"),
    marketLogs("SharePosted"),
    chainNow(pub),
  ]);

  posted.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  const chosen = posted.slice(0, limit);

  const resolvedBy = new Map<string, MarketLog>();
  for (const log of resolvedLogs) {
    resolvedBy.set(String(log.args.triggerId), log);
  }
  const shareCounts = new Map<string, number>();
  for (const log of shareLogs) {
    const key = String(log.args.triggerId);
    shareCounts.set(key, (shareCounts.get(key) ?? 0) + 1);
  }

  const times = await blockTimes(pub, [
    ...chosen.map((l) => l.blockNumber),
    ...resolvedLogs.map((l) => l.blockNumber),
  ]);
  const symbols = await symbolByToken();

  const transfers = await Promise.all(
    chosen.map(async (log): Promise<SealedTransfer> => {
      const id = log.args.triggerId as bigint;
      const key = id.toString();
      const meta = await readMeta(pub, id);
      const condition = decodeCondition({
        recordHex: fieldHex(log.args.publicCondition),
        mode: meta.mode,
        metaT1: meta.t1,
        metaT2: meta.t2,
      });
      const outcome = transferOutcome({
        resolved: meta.resolved,
        deadline: meta.expiry,
        nowUnix: now,
      });
      const postedAt = times.get(log.blockNumber.toString()) ?? null;

      let resolvedAt: number | null = null;
      let instruction: Instruction | null = null;
      const resolvedLog = resolvedBy.get(key);
      if (outcome === "open" && resolvedLog) {
        resolvedAt = times.get(resolvedLog.blockNumber.toString()) ?? null;
        instruction = instructionFromPlaintext(
          fieldHex(resolvedLog.args.plaintext) ?? "0x",
          symbols,
        );
      }

      return {
        id: key,
        author: (log.args.author as string) ?? null,
        condition,
        deadline: meta.expiry,
        postedAt,
        resolvedAt,
        outcome,
        k: meta.k,
        m: meta.m,
        sharesPosted: shareCounts.get(key) ?? 0,
        commit: meta.commit,
        instruction,
      };
    }),
  );

  const counts = { sealed: 0, open: 0, expired: 0 };
  for (const transfer of transfers) {
    counts[transfer.outcome] += 1;
  }
  return { nowUnix: now, total: transfers.length, counts, transfers };
}

/** Map a keyId to its node id via the current candidate set, best-effort. */
async function keyToNode(pub: PublicClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const addr = await addresses();
    const candidates = await fetchCandidates(pub, {
      registry: addr.registry,
      staking: addr.staking,
    });
    for (const candidate of candidates) {
      map.set(candidate.keyId.toString(), candidate.nodeId.toString());
    }
  } catch {
    // The committee panel's node ids are a nicety, not load-bearing.
  }
  return map;
}

/** Build a transfer's timeline from its per-event logs. */
function timelineOf(groups: Record<string, MarketLog[]>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const [type, logs] of Object.entries(groups)) {
    for (const log of logs) {
      entries.push({
        type,
        block: Number(log.blockNumber),
        logIndex: log.logIndex,
        txHash: log.transactionHash,
      });
    }
  }
  entries.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return entries;
}

/**
 * `GET /api/transfer?id=N`: one sealed transfer in full — its trigger, outcome,
 * committee, timeline, and (once open) the revealed instruction.
 */
export async function readTransfer(id: bigint): Promise<TransferDetail | null> {
  const pub = client();
  const key = id.toString();
  const [posts, shares, resolves, expiries, hooks, meta, now] =
    await Promise.all([
      marketLogs("TriggerPosted", { triggerId: id }),
      marketLogs("SharePosted", { triggerId: id }),
      marketLogs("TriggerResolved", { triggerId: id }),
      marketLogs("TriggerExpired", { triggerId: id }),
      marketLogs("HookInvoked", { triggerId: id }),
      readMeta(pub, id),
      chainNow(pub),
    ]);

  const post = posts[0];
  if (!post && meta.expiry === 0) {
    return null;
  }

  const condition = decodeCondition({
    recordHex: post ? fieldHex(post.args.publicCondition) : null,
    mode: meta.mode,
    metaT1: meta.t1,
    metaT2: meta.t2,
  });
  const outcome = transferOutcome({
    resolved: meta.resolved,
    deadline: meta.expiry,
    nowUnix: now,
  });

  const times = await blockTimes(pub, [
    ...(post ? [post.blockNumber] : []),
    ...resolves.map((l) => l.blockNumber),
  ]);
  const postedAt = post
    ? (times.get(post.blockNumber.toString()) ?? null)
    : null;

  let resolvedAt: number | null = null;
  let instruction: Instruction | null = null;
  const resolvedLog = resolves[0];
  if (outcome === "open" && resolvedLog) {
    resolvedAt = times.get(resolvedLog.blockNumber.toString()) ?? null;
    instruction = instructionFromPlaintext(
      fieldHex(resolvedLog.args.plaintext) ?? "0x",
      await symbolByToken(),
    );
  }

  const sharedSlots = new Set(shares.map((l) => Number(l.args.slot)));
  const nodeByKey = await keyToNode(pub);
  const keyIds = (post?.args.keyIds as bigint[] | undefined) ?? [];
  const committee: CommitteeSlot[] = keyIds.map((keyId, slot) => ({
    slot,
    keyId: keyId.toString(),
    nodeId: nodeByKey.get(keyId.toString()) ?? null,
    shared: sharedSlots.has(slot),
  }));

  const timeline = timelineOf({
    TriggerPosted: posts,
    SharePosted: shares,
    TriggerResolved: resolves,
    TriggerExpired: expiries,
    HookInvoked: hooks,
  });

  const spotUsd = await spotFor(condition.price?.asset ?? null);

  return {
    id: key,
    author: (post?.args.author as string) ?? null,
    condition,
    deadline: meta.expiry,
    postedAt,
    resolvedAt,
    outcome,
    k: meta.k,
    m: meta.m,
    sharesPosted: shares.length,
    commit: meta.commit,
    instruction,
    postTx: post?.transactionHash ?? null,
    timeline,
    committee,
    spotUsd,
  };
}

/** A best-effort spot read for the detail view; null when unavailable. */
async function spotFor(asset: string | null): Promise<string | null> {
  if (!asset) {
    return null;
  }
  const id = ASSET_IDS[asset];
  if (id === undefined) {
    return null;
  }
  try {
    const { fetchSpotMedian } = await import("@nillion/covenants-sdk");
    return formatSpot((await fetchSpotMedian(id)).price1e8);
  } catch {
    return null;
  }
}

function fieldHex(value: unknown): string | null {
  if (typeof value === "string" && value.length > 2) {
    return value;
  }
  return null;
}

function formatSpot(spot1e8: bigint): string {
  const whole = spot1e8 / 100000000n;
  return `$${whole.toLocaleString("en-US")}`;
}
