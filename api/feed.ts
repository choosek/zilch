/**
 * GET /api/feed?limit=N — the most recent sealed transfers with a live tally.
 * `limit` is clamped to a sane window.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, queryParam, send } from "../src/server/http.js";
import { readFeed } from "../src/server/transfers.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    return fail(res, 405, "GET only");
  }
  const raw = Number(queryParam(req, "limit") ?? "50");
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(1, Math.trunc(raw)), 200)
    : 50;
  try {
    return send(res, await readFeed(limit));
  } catch (error) {
    return fail(res, 502, "could not read the feed", (error as Error).message);
  }
}
