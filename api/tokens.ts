/**
 * GET /api/tokens — the confidential tokens zilch can use, discovered from Zama's
 * on-chain wrappers registry (valid ERC-7984 pairs, with symbols and decimals).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, send } from "../src/server/http.js";
import { listTokens } from "../src/server/tokens.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    fail(res, 405, "GET only");
    return;
  }
  try {
    send(res, await listTokens());
  } catch (error) {
    fail(
      res,
      502,
      "could not read the token registry",
      (error as Error).message,
    );
  }
}
