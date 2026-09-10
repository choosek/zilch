/**
 * GET /api/config — deployment-facing configuration for the settlement hook.
 *
 * Reports the chain, the Blacklight `TriggerMarket` address (the constructor
 * argument the hook needs), the configured hook address (`ZILCH_HOOK`, if any),
 * and whether atomic settlement is therefore enabled. The deploy dashboard reads
 * this to deploy the hook and generate the config.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { addresses, CHAIN_ID } from "../src/server/chain.js";
import { fail, send } from "../src/server/http.js";
import type { ConfigResponse } from "../src/shared/types.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    return fail(res, 405, "GET only");
  }
  const hook = process.env.ZILCH_HOOK ?? null;
  const body: ConfigResponse = {
    chainId: CHAIN_ID,
    market: null,
    hook,
    atomic: hook !== null,
  };
  try {
    // The market address is resolved off C0 on-chain; needs an RPC endpoint.
    body.market = (await addresses()).market;
  } catch {
    // Leave market null; the dashboard lets the developer supply it by hand.
  }
  return send(res, body);
}
