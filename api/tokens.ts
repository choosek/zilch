/**
 * GET /api/tokens — the confidential tokens zilch can use (Zama's deployed
 * ERC-7984 set). Config-driven and RPC-free, so the funding panel loads instantly.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, send } from "../src/server/http.js";
import { listTokens } from "../src/server/tokens.js";

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    fail(res, 405, "GET only");
    return;
  }
  send(res, listTokens());
}
