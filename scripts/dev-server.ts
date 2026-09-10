#!/usr/bin/env tsx
/**
 * A dependency-light local dev server — the app with no Vercel CLI in the loop.
 *
 * It serves the built client from `public/` and routes `/api/*` to the same
 * handler files Vercel runs, shimming the two request fields they read (`query`,
 * `body`) onto Node's request. Use it when you want to run Conclave locally
 * without `vercel dev` (or when framework auto-detection gets in the way):
 *
 *   pnpm build            # generate public/app.js
 *   pnpm dev:local        # tsx scripts/dev-server.ts  → http://localhost:3000
 *
 * It is a convenience for local testing only; production still runs on Vercel.
 */

import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT ?? 3000);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  for (const candidate of [filePath, `${filePath}.html`]) {
    try {
      const data = await readFile(candidate);
      res.setHeader(
        "content-type",
        CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
      );
      res.setHeader("cache-control", "no-store");
      res.end(data);
      return;
    } catch {
      // try the next candidate
    }
  }
  res.statusCode = 404;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<h1>404</h1><p>Not found. Did you run <code>pnpm build</code>?</p>");
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const name = url.pathname.slice("/api/".length).replace(/\/+$/, "");
  let handler: Handler;
  try {
    const mod = (await import(join(root, "api", `${name}.ts`))) as {
      default: Handler;
    };
    handler = mod.default;
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: `no api route /api/${name}` }));
    return;
  }

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  let body: unknown = {};
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
  }

  // The handlers read only these two fields off the request; Vercel populates
  // them the same way.
  (req as IncomingMessage & { query: unknown; body: unknown }).query = query;
  (req as IncomingMessage & { query: unknown; body: unknown }).body = body;

  try {
    await handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(
      JSON.stringify({ error: (error as Error).message ?? String(error) }),
    );
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url);
  } else {
    void serveStatic(res, url.pathname);
  }
});

server.listen(port, () => {
  console.log(
    `zilch dev → http://localhost:${port}  (static: public/, api: api/*)`,
  );
});
