/**
 * POST /api/tx — build one confidential-token transaction (faucet, approve,
 * wrap, or a confidential send). The `send` kind carries the Zama-produced
 * ciphertext handle and input proof. Malformed → 400.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, send } from "../src/server/http.js";
import { buildTokenTx, InvalidTx } from "../src/server/tokens.js";
import type { TxRequest } from "../src/shared/types.js";

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "POST") {
    fail(res, 405, "POST only");
    return;
  }
  try {
    send(res, buildTokenTx((req.body ?? {}) as TxRequest));
  } catch (error) {
    if (error instanceof InvalidTx) {
      fail(res, 400, error.message);
      return;
    }
    fail(res, 502, "could not build the transaction", (error as Error).message);
  }
}
