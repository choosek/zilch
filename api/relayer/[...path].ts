/**
 * Relayer proxy — forwards the browser's relayer calls to a relayer from the
 * server side, injecting whatever credential that relayer needs so it never
 * reaches the client.
 *
 * The client points its `relayerUrl` at `/api/relayer` (see `src/client/app.ts`)
 * and this route forwards each request to `ZAMA_RELAYER_URL`. The request body is
 * streamed through untouched, so encrypted inputs, proofs, and signatures arrive
 * byte-for-byte.
 *
 * Two credential modes, both optional and independent:
 *   - `ZAMA_RELAYER_API_KEY` → sent as `x-api-key`. Zama's hosted mainnet relayer
 *     (`relayer.mainnet.zama.org`, the default `ZAMA_RELAYER_URL`) requires this.
 *   - `RELAYER_TOKEN` → sent as `x-relayer-token`. Use this with a self-hosted
 *     relayer fronted by a reverse proxy that gates on a shared secret; no Zama
 *     API key is needed there, so leave `ZAMA_RELAYER_API_KEY` unset and point
 *     `ZAMA_RELAYER_URL` at your own relayer.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Stream the body through verbatim rather than let Vercel parse and re-serialize
// it, so the bytes the relayer authenticates are exactly what the SDK sent.
export const config = { api: { bodyParser: false } };

const RELAYER = (
  process.env.ZAMA_RELAYER_URL ?? "https://relayer.mainnet.zama.org"
).replace(/\/$/, "");

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const param = (req.query.path ?? []) as string | string[];
  const path = (Array.isArray(param) ? param : [param]).join("/");
  const query =
    req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const target = `${RELAYER}/${path}${query}`;

  const headers: Record<string, string> = {};
  const contentType = req.headers["content-type"];
  if (contentType) {
    headers["content-type"] = contentType;
  }
  const apiKey = process.env.ZAMA_RELAYER_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  const token = process.env.RELAYER_TOKEN;
  if (token) {
    headers["x-relayer-token"] = token;
  }

  let body: Buffer | undefined;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }

  const init: RequestInit = { method: req.method, headers };
  if (body !== undefined) {
    init.body = new Uint8Array(body);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    res
      .status(502)
      .json({ error: "relayer unreachable", detail: (error as Error).message });
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  const responseType = upstream.headers.get("content-type");
  if (responseType) {
    res.setHeader("content-type", responseType);
  }
  res.send(buffer);
}
