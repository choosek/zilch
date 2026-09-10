import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Absolute path to `src`, so the `#/*` tsconfig alias resolves in tests without
 *  pulling `vite` in as a direct dependency (which would make Vercel misdetect
 *  the whole project as a Vite app). vitest bundles its own vite internally. */
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^#\//, replacement: `${src}/` }],
  },
  test: {
    testTimeout: 20000,
    coverage: {
      enabled: true,
      provider: "v8",
      all: true,
      // The pure, dependency-free core is the surface that can be — and is —
      // covered in full. The serverless handlers and the browser client are I/O
      // against a live chain and a wallet; they are validated on deploy rather
      // than coverage-gated here. See the README's "Testing and conventions".
      include: ["src/core/**/*.ts"],
      exclude: ["**/*.d.ts"],
      reporter: ["text", "json-summary", "json", "lcov"],
      reportOnFailure: true,
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
