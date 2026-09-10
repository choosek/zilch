/**
 * GET /api/balance?token=0x…&account=0x… — the confidential balance handle for an
 * account and token. The handle is a ciphertext reference; the browser decrypts
 * it with an EIP-712 permit, so no cleartext ever passes through here.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fail, queryParam, send } from "../src/server/http.js";
import { readBalanceHandle } from "../src/server/tokens.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    return fail(res, 405, "GET only");
  }
  const tokenAddr = queryParam(req, "token");
  const account = queryParam(req, "account");
  if (!tokenAddr || !account) {
    return fail(res, 400, "token and account required");
  }
  try {
    const handle = await readBalanceHandle(tokenAddr, account);
    return send(res, { handle });
  } catch (error) {
    return fail(
      res,
      502,
      "could not read the balance",
      (error as Error).message,
    );
  }
}
