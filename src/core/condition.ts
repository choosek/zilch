/**
 * Shaping a covenant's release condition into the view model the UI renders.
 *
 * The 52-byte on-chain record is decoded by the SDK on the server (its layout is
 * the SDK's to own); what remains is the branchy part — deciding whether a
 * covenant shows a price clause, a time window, both, or a sealed threshold, and
 * mapping the numeric comparator to an operator. That logic lives here, as a pure
 * function of already-decoded fields, so every combination is unit-tested without
 * a chain or the SDK.
 */

import type {
  DecodedCondition,
  PriceClause,
  WindowClause,
} from "../shared/types.js";
import { formatDateUtc, formatUsd } from "./format.js";

/** Comparator codes as they appear in a decoded condition record. */
export const COMPARATOR_NONE = 0;
export const COMPARATOR_GTE = 1;
export const COMPARATOR_LTE = 2;

/** Render a comparator operator as its mathematical symbol. */
export function opSymbol(op: string): string {
  if (op === ">=") {
    return "≥";
  }
  if (op === "<=") {
    return "≤";
  }
  return op;
}

/** A one-line, human-readable rendering of a decoded trigger. */
export function triggerText(
  price: PriceClause | null,
  window: WindowClause | null,
  sealed: boolean,
): string {
  const parts: string[] = [];
  if (price) {
    parts.push(
      `${price.asset} ${opSymbol(price.op)} ${formatUsd(price.thresholdUsd)}`,
    );
  } else if (sealed) {
    parts.push("a sealed trigger");
  }
  if (window) {
    parts.push(`by ${formatDateUtc(window.t2)}`);
  }
  return parts.length ? parts.join(" ") : "—";
}

/** Map a comparator code to its operator, or `null` when there is no price
 *  clause (`COMPARATOR_NONE`) or the code is unrecognized. */
export function comparatorOp(comparator: number): string | null {
  if (comparator === COMPARATOR_GTE) {
    return ">=";
  }
  if (comparator === COMPARATOR_LTE) {
    return "<=";
  }
  return null;
}

/** A decoded price record, as the server hands it over after calling the SDK's
 *  `parseConditionRecord` and resolving the asset id to a name. Present only for
 *  a Public covenant whose 52-byte record was found on-chain. */
export interface DecodedRecord {
  assetName: string;
  comparator: number;
  threshold1e8: string;
  thresholdUsd: string;
  t1: number;
  t2: number;
  hex: string;
}

/** The inputs the shaper needs: the covenant's mode, the public time window from
 *  `triggerMeta` (zero when none), and the decoded price record when one exists. */
export interface ConditionInput {
  mode: number;
  metaT1: number;
  metaT2: number;
  record: DecodedRecord | null;
}

/**
 * Assemble the condition view model.
 *
 * With a record in hand, a price clause is emitted when the comparator denotes
 * one, and the window is taken from the record when it carries one and otherwise
 * from `triggerMeta`. Without a record, the price threshold is not on-chain: a
 * Private covenant (mode `0`) reports it as `sealed`, while any public window
 * from `triggerMeta` is still shown. The raw hex is carried through only when a
 * record was present, since that is the only case in which it is public.
 */
export function describeCondition(input: ConditionInput): DecodedCondition {
  const { mode, metaT1, metaT2, record } = input;
  const metaWindow =
    metaT1 > 0 || metaT2 > 0 ? { t1: metaT1, t2: metaT2 } : null;

  if (record) {
    const op = comparatorOp(record.comparator);
    const price = op
      ? {
          asset: record.assetName,
          op,
          threshold1e8: record.threshold1e8,
          thresholdUsd: record.thresholdUsd,
        }
      : null;
    const window =
      record.t1 > 0 || record.t2 > 0
        ? { t1: record.t1, t2: record.t2 }
        : metaWindow;
    return {
      mode,
      price,
      window,
      sealed: false,
      raw: record.hex,
      text: triggerText(price, window, false),
    };
  }

  const sealed = mode === 0;
  return {
    mode,
    price: null,
    window: metaWindow,
    sealed,
    raw: null,
    text: triggerText(null, metaWindow, sealed),
  };
}
