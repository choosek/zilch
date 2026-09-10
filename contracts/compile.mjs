import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import solc from "solc";

const ROOT = resolve(".");
const entry = "contracts/src/ZilchSettlementHook.sol";
const input = {
  language: "Solidity",
  sources: { [entry]: { content: readFileSync(entry, "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
function findImports(path) {
  try {
    // bare specifiers (@fhevm/…, @openzeppelin/…) resolve from node_modules;
    // solc pre-joins relative imports into full specifiers before calling us.
    const full =
      path.startsWith(".") || path.startsWith("/")
        ? resolve(ROOT, path)
        : resolve(ROOT, "node_modules", path);
    return { contents: readFileSync(full, "utf8") };
  } catch (e) {
    return { error: `not found: ${path} (${e.message})` };
  }
}
const out = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImports }),
);
const errs = (out.errors || []).filter((e) => e.severity === "error");
const warns = (out.errors || []).filter((e) => e.severity === "warning");
console.log(`solc ${solc.version()}`);
console.log(`errors: ${errs.length} | warnings: ${warns.length}`);
for (const e of errs.slice(0, 12))
  console.log("ERROR:", e.formattedMessage.split("\n")[0]);
const c = out.contracts?.[entry]?.ZilchSettlementHook;
if (c) {
  console.log("✓ compiled ZilchSettlementHook");
  console.log("  bytecode bytes:", (c.evm.bytecode.object.length / 2) | 0);
  console.log(
    "  abi entries:",
    c.abi.length,
    "| functions:",
    c.abi
      .filter((x) => x.type === "function")
      .map((x) => x.name)
      .join(", "),
  );
}

// Emit a client-importable artifact (ABI + bytecode) for the deploy dashboard.
import { writeFileSync } from "node:fs";

if (c) {
  const artifact = `/**
 * Compiled ZilchSettlementHook artifact (ABI + creation bytecode), emitted by
 * \`node contracts/compile.mjs\` from contracts/src/ZilchSettlementHook.sol with
 * solc ${solc.version().split("+")[0]} (evmVersion cancun, optimizer 200). The
 * deploy dashboard uses these to deploy the contract straight from the wallet.
 * If you edit the contract, recompile to regenerate this file.
 *
 * UNAUDITED, UNTESTED reference bytecode — see contracts/README.md.
 */

export const HOOK_ABI = ${JSON.stringify(c.abi)} as const;

export const HOOK_BYTECODE =
  "0x${c.evm.bytecode.object}" as const;
`;
  writeFileSync("src/client/hookArtifact.ts", artifact);
  console.log("→ wrote src/client/hookArtifact.ts");
}
