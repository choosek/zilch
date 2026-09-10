#!/usr/bin/env tsx
/**
 * Bundle the browser client to `public/app.js`.
 *
 * The client is authored as TypeScript in `src/client` and imports the pure
 * `src/core` helpers; esbuild bundles the tree into a single IIFE that the app
 * shell loads with a plain `<script>` tag. This is the app's only build step, and
 * Vercel runs it through `buildCommand` before serving `public/` as static assets.
 */

import { build } from "esbuild";

async function main(): Promise<void> {
  await build({
    entryPoints: ["src/client/app.ts"],
    outfile: "public/app.js",
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    sourcemap: true,
    legalComments: "none",
    logLevel: "info",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
