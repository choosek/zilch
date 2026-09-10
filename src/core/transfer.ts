/**
 * A sealed transfer's outcome, forced by its covenant's end-state.
 *
 * This is the same shape of logic the covenant tools use, named for this domain.
 * A sealed transfer is a covenant whose payload is a transfer instruction and
 * whose release condition is the trigger. It can only end two ways, both public:
 * the trigger fires and the covenant resolves — the instruction *opens* and is
 * ready to settle — or the deadline passes untouched and the covenant expires,
 * settling to nothing (zilch). Until either, it is still sealed. No oracle is
 * needed beyond the chain's own state.
 */

import type { TransferOutcome } from "../shared/types.js";

/** The on-chain facts an outcome is derived from. `nowUnix` must be chain time
 *  (the latest block's timestamp), since expiry is measured against
 *  `block.timestamp`. */
export interface TransferFacts {
  resolved: boolean;
  deadline: number;
  nowUnix: number | null;
}

/**
 * Reduce a sealed transfer's facts to its outcome. A resolved covenant is `open`
 * regardless of the clock; an unresolved covenant past its deadline is
 * `expired`; anything else is still `sealed`.
 */
export function transferOutcome(facts: TransferFacts): TransferOutcome {
  const { resolved, deadline, nowUnix } = facts;
  if (resolved) {
    return "open";
  }
  if (deadline && nowUnix !== null && nowUnix > deadline) {
    return "expired";
  }
  return "sealed";
}
