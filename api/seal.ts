/**
 * POST /api/seal — seal a transfer instruction into a covenant, returning the
 * transactions the wallet sends. A malformed request is a 400; a chain fault 502.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, send } from "../src/server/http.js";
import { buildSeal, InvalidSeal } from "../src/server/seal.js";
import type { SealRequest } from "../src/shared/types.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return fail(res, 405, "POST only");
  }
  try {
    return send(res, await buildSeal((req.body ?? {}) as SealRequest));
  } catch (error) {
    if (error instanceof InvalidSeal) {
      return fail(res, 400, error.message);
    }
    return fail(
      res,
      502,
      "could not seal this transfer",
      (error as Error).message,
    );
  }
}
