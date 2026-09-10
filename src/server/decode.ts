/**
 * Server-side decoding that needs the SDK or viem, kept apart from the pure view
 * logic it feeds.
 *
 * Two jobs live here. {@link decodeCondition} turns a covenant's on-chain state
 * into the condition view model: it decodes the 52-byte record with the SDK when
 * one is public, resolves the asset id to a name, and hands the numeric fields to
 * the pure shaper in `core/condition`. {@link decodeRevert} names a failed
 * settlement by matching its revert data against the union of every SDK ABI's
 * error fragments, so the X-ray can report `NotResolvable()` rather than a bare
 * "reverted".
 */

import {
  authVerifierAbi,
  emissionsAbi,
  escrowMathAbi,
  hexToBytes,
  nilAbi,
  nodeRegistryAbi,
  parseConditionRecord,
  protocolConfigAbi,
  stakingAbi,
  triggerMarketAbi,
} from "@nillion/blacklight-l1-sdk";
import { type Abi, decodeErrorResult } from "viem";
import { describeCondition } from "../core/condition.js";
import type { DecodedCondition } from "../shared/types.js";
import { assetName, formatPriceDisplay } from "./chain.js";

/** The inputs {@link decodeCondition} needs from a covenant's meta and post log. */
export interface ConditionSource {
  /** The 52-byte `publicCondition` from `TriggerPosted`, as hex, when public. */
  recordHex: string | null;
  mode: number;
  /** The public time window from `triggerMeta` (zero bounds when none). */
  metaT1: number;
  metaT2: number;
}

/**
 * Decode a covenant's release condition into its view model.
 *
 * When a public record is present it is parsed with the SDK and its asset id
 * resolved to a name; the shaping (price vs sealed vs window, and which window
 * wins) is then the pure `describeCondition`. A record that fails to parse is
 * treated as having no price clause, but its hex is still carried through so the
 * raw bytes remain visible.
 */
export function decodeCondition(source: ConditionSource): DecodedCondition {
  const { recordHex, mode, metaT1, metaT2 } = source;
  if (recordHex) {
    try {
      const parsed = parseConditionRecord(
        hexToBytes(recordHex as `0x${string}`),
      );
      return describeCondition({
        mode,
        metaT1,
        metaT2,
        record: {
          assetName: assetName(parsed.assetId),
          comparator: Number(parsed.comparator),
          threshold1e8: parsed.threshold.toString(),
          thresholdUsd: formatPriceDisplay(parsed.threshold) ?? "0",
          t1: Number(parsed.t1),
          t2: Number(parsed.t2),
          hex: recordHex,
        },
      });
    } catch {
      // Unparseable record: no price clause, but keep the hex visible.
      const view = describeCondition({ mode, metaT1, metaT2, record: null });
      return { ...view, raw: recordHex };
    }
  }
  return describeCondition({ mode, metaT1, metaT2, record: null });
}

/** Every SDK ABI, so a revert selector can be matched wherever it is defined. */
const ERROR_ABIS: Abi[] = [
  triggerMarketAbi,
  stakingAbi,
  nodeRegistryAbi,
  protocolConfigAbi,
  nilAbi,
  emissionsAbi,
  escrowMathAbi,
  authVerifierAbi,
] as unknown as Abi[];

/** A decoded revert: its error name (when matched), a human message, and the raw
 *  data when present. */
export interface DecodedRevert {
  name: string | null;
  message: string;
  data?: string;
}

/**
 * Name a reverted call by matching its revert data against the SDK's error set.
 *
 * viem nests the revert data inside the thrown error; this walks the cause chain
 * to find it, then tries each ABI's error fragments until one decodes, rendering
 * the name with its arguments (e.g. `HookGasTooLarge(8000000)`). When no data is
 * present the error's short message is used; when data is present but matches no
 * known error, the selector is reported so it can still be looked up.
 */
export function decodeRevert(error: unknown): DecodedRevert {
  const data = extractRevertData(error);
  if (!data) {
    const message = readMessage(error) ?? "reverted";
    return { name: null, message: message.slice(0, 200) };
  }
  for (const abi of ERROR_ABIS) {
    try {
      const decoded = decodeErrorResult({ abi, data: data as `0x${string}` });
      const args = decoded.args?.length
        ? `(${decoded.args
            .map((value) =>
              typeof value === "bigint" ? value.toString() : String(value),
            )
            .join(", ")})`
        : "()";
      return {
        name: decoded.errorName,
        message: `${decoded.errorName}${args}`,
        data,
      };
    } catch {
      // Not this ABI's error; try the next.
    }
  }
  return {
    name: null,
    message: `reverted (unknown selector ${data.slice(0, 10)})`,
    data,
  };
}

/** Walk a viem error's cause chain for the first `0x`-prefixed `data` field. */
function extractRevertData(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) {
      return data;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Read a `shortMessage` or `message` from an unknown error, if present. */
function readMessage(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string") {
      return short;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return undefined;
}
