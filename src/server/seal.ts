/**
 * Sealing a transfer instruction into a covenant.
 *
 * This is one of zilch's two write paths, and it keeps the server exactly as
 * stateless and fundless as the reads: the server selects a committee, compiles
 * the price trigger, seals the *instruction* (recipient, token, an optional
 * amount commitment, memo), prices the covenant escrow and protocol fee, and
 * returns the transactions the user's own wallet must send. The author of record
 * is the user — msg.sender on the post — so a sealed transfer is attributed. No
 * key, no ETH and no NIL touch this process, and the amount is never here: it
 * lives only in the browser and in Zama's ciphertext at settlement.
 *
 * The committee is selected once, here, and the layers it produces are what the
 * chosen keys must decrypt — so seal and post are one atomic build returned
 * together. (Re-selecting per request is the documented footgun.)
 */

import {
  compileCondition,
  fetchCandidates,
  formatNil,
  hexToBytes,
  MAX_UINT256,
  maxLayerLen,
  nilAbi,
  parsePriceUsd1e8,
  quoteEscrow,
  quoteProtocolFee,
  seal,
  selectCommittee,
  suggestCeiling,
} from "@nillion/blacklight-l1-sdk";
import {
  encodeFunctionData,
  formatEther,
  isAddress,
  toHex,
  zeroAddress,
} from "viem";
import { encodeInstruction } from "../core/instruction.js";
import type { SealRequest, SealResponse } from "../shared/types.js";
import {
  addresses,
  CHAIN_ID,
  client,
  protocolConfigAbi,
  triggerMarketAbi,
} from "./chain.js";

/** A rejected seal: the request is malformed or unsatisfiable. The route maps
 *  this to `400`, distinguishing it from a chain fault (`502`). */
export class InvalidSeal extends Error {}

/** Asset name → id, matching the SDK's append-only tables, so a trigger can be
 *  priced in any supported asset. */
const ASSET_IDS: Record<string, number> = {
  BTC: 1,
  ETH: 2,
  SOL: 3,
  LINK: 4,
  XRP: 5,
  USDT: 6,
};

/** Committee shape targets, reduced to what the live candidate set supports. */
const TARGET_M = 5;
const TARGET_K = 3;

/** The soonest a deadline may be, in seconds from now — a sealed transfer has to
 *  breathe before it can expire. */
const MIN_TTL = 300;
const MAX_MEMO = 120;

/**
 * Seal, price, and encode a transfer instruction, returning the transactions the
 * wallet sends. `approve` is present only when the market's NIL allowance is
 * below the protocol fee; the wallet sends it first, then `post`.
 */
export async function buildSeal(req: SealRequest): Promise<SealResponse> {
  const recipient = validateAddress(req.recipient, "recipient");
  const token = validateAddress(req.token, "token");
  const author = validateAddress(req.author, "author");
  const asset = validateAsset(req.asset);
  const op = validateOp(req.op);
  const targetUsd = validateTarget(req.targetUsd);
  const memo = validateMemo(req.memo);
  const amountCommitment = validateCommitment(req.amountCommitment);

  const pub = client();
  const addr = await addresses();
  const block = await pub.getBlock();
  const now = Number(block.timestamp);

  const ttl = req.deadlineUnix - now;
  if (!Number.isFinite(ttl) || ttl < MIN_TTL) {
    throw new InvalidSeal(
      `deadline must be at least ${MIN_TTL} seconds in the future`,
    );
  }

  const minStake = (await pub.readContract({
    address: addr.config,
    abi: protocolConfigAbi,
    functionName: "minStake",
  })) as bigint;

  const candidates = await fetchCandidates(pub, {
    registry: addr.registry,
    staking: addr.staking,
  });
  if (candidates.length === 0) {
    throw new InvalidSeal("no committee keys are currently registered");
  }
  const m = Math.min(TARGET_M, candidates.length);
  const k = Math.min(TARGET_K, m);

  let committee: ReturnType<typeof selectCommittee>;
  try {
    committee = selectCommittee(candidates, {
      nowUnix: BigInt(now),
      minStake,
      m,
      k,
      mode: "PUBLIC_CONDITION",
    });
  } catch (error) {
    throw new InvalidSeal(
      `could not assemble a committee: ${(error as Error).message}`,
    );
  }

  const record = compileCondition(
    { price: { asset, op, priceUsd: targetUsd } },
    ASSET_IDS,
  );
  const payload = encodeInstruction({
    recipient,
    token,
    amountCommitment,
    memo,
  });
  const sealed = seal(
    payload,
    "PUBLIC_CONDITION",
    record,
    k,
    committee.keys.map((key) => hexToBytes(key.mpk)),
  );

  const basefee = block.baseFeePerGas ?? 1_000_000_000n;
  const ceiling = suggestCeiling(basefee);
  const keyIds = committee.keys.map((key) => key.keyId);

  const quote = await quoteEscrow(pub, addr.market, {
    mode: "PUBLIC_CONDITION",
    keyIds,
    k,
    ceilingWei: ceiling,
    maxLayerLen: maxLayerLen(sealed.layers),
  });
  const fee = await quoteProtocolFee(
    pub,
    { config: addr.config, nil: addr.nil, market: addr.market },
    author,
  );

  const postData = encodeFunctionData({
    abi: triggerMarketAbi,
    functionName: "post_trigger",
    args: [
      {
        mode: 1,
        layers: sealed.layers.map((layer) => toHex(layer)),
        keyIds,
        k,
        ttl,
        commit: sealed.commit,
        ceiling,
        hook: zeroAddress,
        t1: 0n,
        t2: 0n,
        publicCondition: toHex(sealed.publicCondition ?? record),
        hookGasLimit: 0,
        retryWindowSecs: 0,
        noBounty: false,
      },
    ],
  });

  const approve =
    fee.allowanceNil < fee.feeNil
      ? {
          to: addr.nil,
          data: encodeFunctionData({
            abi: nilAbi,
            functionName: "approve",
            args: [addr.market, MAX_UINT256],
          }),
          value: "0x0",
          chainId: CHAIN_ID,
        }
      : null;

  return {
    approve,
    post: {
      to: addr.market,
      data: postData,
      value: toHex(quote.escrowWei),
      chainId: CHAIN_ID,
    },
    commit: sealed.commit,
    committee: {
      m: committee.keys.length,
      k,
      nodeIds: committee.keys.map((key) => key.nodeId.toString()),
    },
    deadlineUnix: req.deadlineUnix,
    note:
      `Covenant escrow ${formatEther(quote.escrowWei)} ETH, protocol fee ${formatNil(fee.feeNil)} NIL. ` +
      (approve === null
        ? "Send the post transaction to seal this transfer."
        : "Two transactions: approve NIL for the fee, then post to seal."),
  };
}

/* ---- validation ---- */

function validateAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value === "string" && isAddress(value)) {
    return value;
  }
  throw new InvalidSeal(`${label} must be a wallet address`);
}

function validateAsset(asset: unknown): string {
  if (typeof asset === "string" && asset in ASSET_IDS) {
    return asset;
  }
  throw new InvalidSeal(
    `asset must be one of ${Object.keys(ASSET_IDS).join(", ")}`,
  );
}

function validateOp(op: unknown): ">=" | "<=" {
  if (op === ">=" || op === "<=") {
    return op;
  }
  throw new InvalidSeal('op must be ">=" or "<="');
}

function validateTarget(target: unknown): string {
  if (typeof target !== "string") {
    throw new InvalidSeal("targetUsd must be a decimal string");
  }
  try {
    parsePriceUsd1e8(target);
  } catch {
    throw new InvalidSeal(
      "targetUsd must be a plain decimal with up to 8 places",
    );
  }
  return target;
}

function validateMemo(memo: unknown): string | undefined {
  if (memo === undefined || memo === null || memo === "") {
    return undefined;
  }
  if (typeof memo !== "string" || memo.length > MAX_MEMO) {
    throw new InvalidSeal(`memo must be a string up to ${MAX_MEMO} chars`);
  }
  return memo;
}

function validateCommitment(commitment: unknown): string | undefined {
  if (commitment === undefined || commitment === null || commitment === "") {
    return undefined;
  }
  if (
    typeof commitment !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(commitment)
  ) {
    throw new InvalidSeal("amountCommitment must be 32 bytes of hex");
  }
  return commitment;
}
