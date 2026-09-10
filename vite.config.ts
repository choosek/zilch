/**
 * Client build.
 *
 * zilch's browser client bundles Zama's v3 SDK (`@zama-fhe/sdk`), whose FHE
 * engine ships WebAssembly and touches a few Node built-ins. Vite handles both
 * out of the box: `vite-plugin-node-polyfills` shims the Node built-ins for the
 * browser, and Vite inlines the engine's WASM from the base64 assets the package
 * provides — so the build emits plain JavaScript with no separate `.wasm` files
 * to serve.
 *
 * To keep the rest of zilch's layout unchanged, this is a *library* build with a
 * single entry, emitted into `public/build/` alongside the hand-written
 * `public/index.html`, which loads `/build/app.js` as a module. The serverless
 * functions in `api/` are untouched by this build; Vercel serves `public/`
 * statically and runs `api/` as functions, exactly as before.
 */

import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills()],
  // The client's static assets (index.html, css, favicon) are authored directly
  // in public/; Vite must not try to copy public/ into its own output.
  publicDir: false,
  build: {
    outDir: "public/build",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    sourcemap: false,
    lib: {
      entry: "src/client/app.ts",
      formats: ["es"],
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        chunkFileNames: "chunk-[hash].js",
        assetFileNames: "asset-[name]-[hash][extname]",
      },
    },
  },
});
