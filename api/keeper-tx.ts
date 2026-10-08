/**
 * POST /api/keeper-tx  { action: "reveal" | "settle", id: "N" }
 *
 * Builds the calldata for one of the two permissionless keeper actions on a
 * sealed transfer's covenant and returns a ready transaction the browser signs.
 * Neither needs the author's key — only a wallet with Sepolia gas:
 *
 *   reveal → post_result(id, plaintext, slots, shares)  once k good shares exist
 *   settle → settle_expired(id)                          close out an expired one
 *
 * A sealed transfer opens when its covenant resolves; the committee normally
 * posts the result once the trigger fires, but `reveal` lets anyone reconstruct
 * it from the posted shares and settle it (earning the reconstructor fee). The
 * ABI stays on the server, and each action is dry-run first so the UI can refuse
 * a transaction that would revert, reported with the protocol's own error name.
 */

import {
  bytesToHex,
  fetchShares,
  reconstructLocally,
} from "@nillion/covenants-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeFunctionData } from "viem";
import {
  addresses,
  CHAIN_ID,
  client,
  pick,
  triggerMarketAbi,
} from "../src/server/chain.js";
import { decodeRevert } from "../src/server/decode.js";
import { fail, send } from "../src/server/http.js";
import type { KeeperAction, KeeperTxResponse } from "../src/shared/types.js";

const SIM_FROM = "0x000000000000000000000000000000000000dEaD" as const;
const ACTIONS: KeeperAction[] = ["reveal", "settle"];

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return fail(res, 405, "POST only");
  }
  const body = (req.body ?? {}) as { action?: string; id?: string | number };
  const action = String(body.action ?? "") as KeeperAction;
  if (!ACTIONS.includes(action)) {
    return fail(res, 400, "unknown action");
  }
  let id: bigint;
  try {
    id = BigInt(body.id as string);
  } catch {
    return fail(res, 400, "id must be an integer");
  }

  let addr: Awaited<ReturnType<typeof addresses>>;
  try {
    addr = await addresses();
  } catch (error) {
    return fail(res, 502, "not on a live deployment", (error as Error).message);
  }
  const pub = client();
  const market = addr.market as `0x${string}`;

  let data: `0x${string}`;
  let note: string;

  if (action === "settle") {
    data = encodeFunctionData({
      abi: triggerMarketAbi,
      functionName: "settleExpired",
      args: [id],
    });
    note = "Closes out the expired transfer and releases the covenant escrow.";
  } else {
    const meta = await pub.readContract({
      address: market,
      abi: triggerMarketAbi,
      functionName: "triggerMeta",
      args: [id],
    });
    const k = Number(pick(meta, 1, "k"));
    const commit = pick<string>(meta, 6, "commit");
    const shares = await fetchShares(pub, market, id).catch(() => []);
    if (shares.length < k) {
      return fail(
        res,
        409,
        `only ${shares.length} of ${k} shares posted — not reconstructable yet`,
      );
    }
    const reconstruction = reconstructLocally(
      shares,
      k,
      commit as `0x${string}`,
    );
    if (!reconstruction) {
      return fail(
        res,
        409,
        "no valid k-subset reconstructs to the commitment yet",
      );
    }
    data = encodeFunctionData({
      abi: triggerMarketAbi,
      functionName: "postResult",
      args: [
        id,
        bytesToHex(reconstruction.plaintext),
        reconstruction.usedSlots,
        reconstruction.usedShares.map((share) => bytesToHex(share)),
      ],
    });
    note = `Opens the instruction from ${reconstruction.usedSlots.length} shares and settles the covenant. You earn the reconstructor fee.`;
  }

  let simulated = "ok";
  try {
    await pub.call({ account: SIM_FROM, to: market, data });
  } catch (error) {
    simulated = decodeRevert(error).message;
  }

  const response: KeeperTxResponse = {
    action,
    id: id.toString(),
    tx: { to: market, data, value: "0x0", chainId: CHAIN_ID },
    simulated,
    note,
  };
  return send(res, response);
}
