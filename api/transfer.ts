/**
 * GET /api/transfer?id=N — one sealed transfer in full, or 404 if unknown.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, queryParam, send } from "../src/server/http.js";
import { readTransfer } from "../src/server/transfers.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    return fail(res, 405, "GET only");
  }
  const idParam = queryParam(req, "id");
  if (idParam === null) {
    return fail(res, 400, "id required");
  }
  let id: bigint;
  try {
    id = BigInt(idParam);
  } catch {
    return fail(res, 400, "id must be an integer");
  }
  try {
    const detail = await readTransfer(id);
    if (!detail) {
      return fail(res, 404, "no such sealed transfer");
    }
    return send(res, detail);
  } catch (error) {
    return fail(
      res,
      502,
      "could not read the transfer",
      (error as Error).message,
    );
  }
}
