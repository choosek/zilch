/**
 * The wire contract between zilch's serverless API and its browser client.
 *
 * zilch pairs two confidentiality primitives on one action. A Blacklight
 * *Covenant* seals a transfer instruction and opens it when a price or time
 * condition fires; a Zama *confidential token* (ERC-7984) carries the amount as
 * an encrypted handle that never becomes public. This module names the shapes
 * both halves speak in.
 *
 * As with the covenant work these types descend from, large on-chain quantities
 * (price thresholds, escrow) cross the wire as decimal strings and small ones
 * (unix seconds, counts) as numbers, and the server sends a preformatted display
 * string next to any raw value a person reads. The amount is deliberately absent
 * from every shape here: it lives only in the browser and in Zama's ciphertext,
 * and the server never sees it.
 */

/* ---- the covenant's release condition (the trigger) ---- */

/** A price clause decoded from a sealed transfer's trigger. */
export interface PriceClause {
  asset: string;
  op: string; // ">=" or "<="
  threshold1e8: string;
  thresholdUsd: string;
}

/** A time-window clause: unix seconds, both bounds present. */
export interface WindowClause {
  t1: number;
  t2: number;
}

/** The decoded trigger of a sealed transfer. */
export interface DecodedCondition {
  mode: number; // 0 Private, 1 Public
  price: PriceClause | null;
  window: WindowClause | null;
  sealed: boolean;
  raw: string | null;
  text: string; // e.g. "ETH ≥ $5,000" or "12 Jun 2026"
}

/* ---- the sealed instruction (the covenant payload) ---- */

/**
 * What a sealed transfer commits to, carried inside the covenant's sealed
 * payload and revealed only when it opens. Note what is *not* here: the amount.
 * The amount is an encrypted ERC-7984 handle moved at settlement, so it is
 * concealed by the token before the covenant opens and by Zama forever after.
 * `amountCommitment` is an optional `keccak256(amount‖salt)` that binds the
 * amount at seal time without revealing it.
 */
export interface Instruction {
  recipient: string;
  token: string; // the ERC-7984 confidential token address
  tokenSymbol: string | null;
  memo: string | null;
  amountCommitment: string | null;
}

/** A sealed transfer's outcome, forced by its covenant's end-state: it is still
 *  `sealed` while the trigger has not fired, `open` once the covenant resolves
 *  and the instruction is revealed, and `expired` if the deadline passed
 *  untouched — in which case it settles to nothing (zilch). */
export type TransferOutcome = "sealed" | "open" | "expired";

/** One sealed transfer, as shown in the feed and at the top of its detail. */
export interface SealedTransfer {
  id: string;
  author: string | null;
  condition: DecodedCondition;
  deadline: number;
  postedAt: number | null;
  resolvedAt: number | null;
  outcome: TransferOutcome;
  k: number;
  m: number;
  sharesPosted: number;
  commit: string;
  instruction: Instruction | null; // revealed only once open
}

/** `GET /api/feed`. */
export interface FeedResponse {
  nowUnix: number;
  total: number;
  counts: { sealed: number; open: number; expired: number };
  transfers: SealedTransfer[];
}

/** One event in a sealed transfer's timeline. */
export interface TimelineEntry {
  type: string;
  block: number;
  logIndex: number;
  txHash: string;
}

/** One committee slot backing a sealed transfer. */
export interface CommitteeSlot {
  slot: number;
  keyId: string | null;
  nodeId: string | null;
  shared: boolean;
}

/** `GET /api/transfer?id=N`. */
export interface TransferDetail extends SealedTransfer {
  postTx: string | null;
  timeline: TimelineEntry[];
  committee: CommitteeSlot[];
  spotUsd: string | null;
}

/* ---- Zama confidential tokens (read from Zama's official registry) ---- */

/** One confidential-token pairing from Zama's Confidential Token Wrappers
 *  Registry: an ERC-20 underlying and its ERC-7984 confidential wrapper. */
export interface TokenPair {
  symbol: string; // the confidential token's symbol, e.g. "cUSDC"
  confidentialToken: string;
  underlying: string;
  underlyingSymbol: string;
  decimals: number; // the confidential token's decimals: balances, transfers
  underlyingDecimals: number; // the underlying ERC-20's decimals: wrap + faucet amounts
  hasFaucet: boolean;
}

/** `GET /api/tokens`. */
export interface TokensResponse {
  registry: string;
  tokens: TokenPair[];
}

/* ---- building transactions (the server holds the ABIs; the wallet signs) ---- */

/** A ready transaction for the wallet to send. Used for the covenant post and
 *  keeper actions; confidential-token operations are done in the browser by
 *  Zama's SDK and never cross this wire. */
export interface Tx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/** `POST /api/seal` request: the transfer to seal into a covenant. */
export interface SealRequest {
  recipient: string;
  token: string;
  tokenSymbol?: string;
  memo?: string;
  amountCommitment?: string;
  asset: string;
  op: string; // ">=" or "<="
  targetUsd: string;
  deadlineUnix: number;
  author: string;
  /** When true (and the server has ZILCH_HOOK set), the covenant is posted with
   *  the settlement hook wired in for atomic release. */
  useHook?: boolean;
}

/** `POST /api/seal` response: the transactions the wallet sends to seal it. */
export interface SealResponse {
  approve: Tx | null;
  post: Tx;
  commit: string;
  committee: { m: number; k: number; nodeIds: string[] };
  deadlineUnix: number;
  /** A best-effort dry-run of the post: `"ok"`, a revert reason, or a note that
   *  it was not simulated because a NIL approval must be sent first. */
  simulated: string;
  note: string;
}

/* ---- keeper actions on a sealed transfer's covenant ---- */

export type KeeperAction = "reveal" | "settle";

/** `POST /api/keeper-tx`. */
export interface KeeperTxResponse {
  action: KeeperAction;
  id: string;
  tx: Tx;
  simulated: string;
  note: string;
}

/** `GET /api/config` — settlement-hook deployment configuration. */
export interface ConfigResponse {
  chainId: number;
  /** The Blacklight TriggerMarket address (the hook's constructor argument). */
  market: string | null;
  /** The configured settlement hook address, or null if none. */
  hook: string | null;
  /** Whether atomic settlement is enabled (a hook is configured). */
  atomic: boolean;
}

/** The uniform error body every route returns on failure. */
export interface ErrorResponse {
  error: string;
  detail?: string;
}
