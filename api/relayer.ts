/**
 * Relayer proxy — forwards the browser's relayer calls to a relayer from the
 * server side, injecting whatever credential that relayer needs so it never
 * reaches the client.
 *
 * The client points its `relayerUrl` at `/api/relayer` (see `src/client/app.ts`).
 * A rewrite in `vercel.json` funnels every `/api/relayer/<sub/path>` request into
 * this one top-level function, carrying the sub-path in the `path` query
 * parameter, so a single function serves the whole relayer surface
 * (`/v2/user-decrypt`, `/v2/keyurl`, `/v2/input-proof`, and so on). A single
 * top-level function is routed reliably by Vercel, where a nested catch-all
 * (`api/relayer/[...path].ts`) is not. The request body is streamed through
 * untouched, so encrypted inputs, proofs, and signatures arrive byte-for-byte.
 *
 * Two credential modes, both optional and independent:
 *   - `ZAMA_RELAYER_API_KEY` is sent as `x-api-key`. Zama's hosted mainnet relayer
 *     (`relayer.mainnet.zama.org`, the default `ZAMA_RELAYER_URL`) requires this.
 *   - `RELAYER_TOKEN` is sent as `x-relayer-token`. Use this with a self-hosted
 *     relayer fronted by a reverse proxy that gates on a shared secret; no Zama
 *     API key is needed there, so leave `ZAMA_RELAYER_API_KEY` unset and point
 *     `ZAMA_RELAYER_URL` at your own relayer.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const RELAYER = (
  process.env.ZAMA_RELAYER_URL ?? "https://relayer.mainnet.zama.org"
).replace(/\/$/, "");

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // The vercel.json rewrite carries the relayer sub-path in `path`; any other
  // query parameters are forwarded on verbatim.
  const rawPath = req.query.path;
  const path = (
    Array.isArray(rawPath) ? rawPath.join("/") : (rawPath ?? "")
  ).replace(/^\/+/, "");

  const forwarded = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        forwarded.append(key, item);
      }
    } else if (value !== undefined) {
      forwarded.append(key, value);
    }
  }
  const search = forwarded.toString();
  const target = `${RELAYER}/${path}${search ? `?${search}` : ""}`;

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

  // @vercel/node hands the handler a raw request stream (it does not parse the
  // body), so read the bytes and forward them untouched.
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
