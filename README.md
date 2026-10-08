# zilch

[![network](https://img.shields.io/badge/network-Ethereum%20mainnet-2b4bff)](https://etherscan.io)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A template dApp that pairs two confidentiality primitives on one payment: a [Zama](https://docs.zama.org/protocol) confidential token hides the **amount**, and a [Nillion Blacklight L1](https://docs.nillion.com) *Covenant* seals the **instruction** and opens it only when the price or the clock says so. It runs on [Ethereum mainnet](https://etherscan.io), in the browser and on [Vercel](https://vercel.com), atop Zama's ERC-7984 tokens (discovered from Zama's on-chain registry) and the Blacklight L1 network, plus one custom contract (a settlement hook) that binds the two halves so the payment settles **atomically** when the Covenant opens.

## What zilch Does

A number of recent projects supporting private transactions in some form encrypt *how much value moved*. What Covenants encrypt is orthogonal: the *instruction* to execute (and, in future releases, the *condition* under which that sealed instruction can be revealed and executed). Neither alone conceals a whole transfer; together they cover each other's gap. **zilch** is a minimal demonstration of that pairing: you compose a payment, the amount is encrypted in your browser and never leaves it in the clear, and the instruction (who is paid, in which token, with what memo) is sealed into a Covenant that publishes only its *trigger* and opens itself when that trigger fires.

The result is a transfer whose timing and instruction were a sealed envelope that opened on cue, and whose amount was and remains concealed by the token's value machinery. That is the line from Choose K's write-up made concrete: *"the value layer hides the magnitude a Covenant alone might otherwise need to reveal, and the Covenant seals the queued instruction which the value layer leaves exposed."*

## How a Sealed Transfer Works

A **sealed transfer** is a Covenant whose sealed payload is a transfer instruction and whose release condition is a price or time trigger. It can only end two ways, both public and both settled by the staked committee rather than an oracle, so its state is a pure function of what the chain already exposes:

| State     | What it means                                                      |  The on-chain fact behind it                       |
|-----------|---------------------------------------------------------------------|---------------------------------------------------|
| `sealed`  | The trigger has not fired; the instruction is hidden.               | The Covenant is unresolved and before its deadline. |
| `open`    | The trigger fired; the instruction is revealed and the escrowed amount is released to the recipient. | The Covenant resolved: a `TriggerResolved` event carries the plaintext. |
| `expired` | The deadline passed untriggered; it settles to nothing (*zilch*).   | The Covenant is unresolved and past its deadline.  |

When a transfer opens, the committee's reconstruction makes the instruction public. However, *the amount is never part of it*. The amount lives only in Zama's ciphertext, so opening the envelope reveals *who* and *what*, never *how much*.

## Two Primitives/Protocols

Each primitive conceals exactly what the other would expose:

| Attribute                          | Concealed by                                          | Public                          |
|------------------------------------|-------------------------------------------------------|---------------------------------|
| Amount                             | Zama ERC-7984 — an encrypted `euint64` balance handle | that *a* transfer occurred      |
| Instruction (recipient, token, memo) | Covenant — the sealed payload                       | the trigger (a price or a time) |
| Condition                          | public here; sealable in Nillion's later *Neon* phase | —                               |

**The instruction half (Covenant).** A Covenant seals bytes to a *k*-of-*m* committee, publishes a release condition, and lets the committee open the payload when the condition fires. zilch seals a compact instruction (a magic header, the recipient, the token, an optional amount commitment, and a memo) with a public price condition, so the trigger is legible in the feed while the instruction stays sealed until it opens.

**The amount half (Zama).** ERC-7984 mirrors ERC-20 but every balance and transfer amount is a ciphertext handle; the contract adds and subtracts without seeing the numbers. zilch drives it in the browser with [Zama's v3 SDK](https://docs.zama.org/protocol/sdk) (`@zama-fhe/sdk`): a `WrappedToken` handle exposes `shield` (wrap public into confidential), `confidentialTransfer` (encrypt the amount and send), and `balanceOf` (decrypt your own balance behind an [EIP-712](https://eips.ethereum.org/EIPS/eip-712) session permit the SDK manages). The SDK talks to a Zama mainnet relayer for the FHE key material and proofs. Nothing but ciphertexts touch the chain, and nothing but the wallet-held permit can decrypt them.

## Workflow Overview

Everything below is a browser action against deployed contracts, signed by your wallet. The server never holds a key, ETH, or NIL.

1. **Fund.** Pick a confidential token (zilch discovers the registered ERC-7984 wrappers from Zama's on-chain registry) then `shield` underlying tokens you already hold into a confidential balance (one call that approves the wrapper and wraps). Decrypt the balance back (something only you can do). There is no faucet on mainnet; you fund by wrapping real tokens.
2. **Seal.** Compose `{recipient, amount, trigger, deadline, memo}`. The still-encrypted amount is escrowed into the settlement hook, and the instruction is sealed into a Covenant via `/api/seal`; your wallet posts it (paying the Covenant escrow, the NIL protocol fee, and gas — you are the author of record).
3. **Watch.** The feed shows sealed transfers counting down toward their triggers.
4. **Open & settle.** When the trigger fires, the committee resolves the Covenant: the instruction opens and, *in the same transaction*, the settlement hook releases the escrowed amount to the recipient. If it lingers, anyone can reveal it (by reconstructing from the posted shares) for the reconstructor fee.
5. **Done.** The recipient decrypts their balance privately; the amount was never public on-chain. If a Covenant expires untriggered, the sender reclaims the escrow with a refund.

## The Settlement Hook

zilch deploys a single contract of its own: `ZilchSettlementHook`. Everything else runs on infrastructure that is already on-chain: Zama's deployed ERC-7984 tokens, and the standing Blacklight L1 network, which needs no bespoke contract to seal, post, read, reveal, or resolve a Covenant.

The hook exists to make settlement **atomic**. A Covenant cannot itself call `confidentialTransfer` when it opens; that bridge is a *hook*, and a hook is a contract. So the hook escrows the confidential amount when a transfer is sealed and, inside the Covenant's reveal transaction, releases it to the sealed recipient: the payment happens if and only if the Covenant opens, for the escrowed (still-encrypted) amount, to the sealed recipient (enforced on-chain). If a Covenant expires untriggered, the sender reclaims the escrow with `refund`.

The contract is **unaudited**: a reference to build on, not a validated dependency. It is deployed by the operator, not by this repository. It is wired in through `ZILCH_HOOK`; with no hook configured, zilch falls back to a hookless mode where settlement is a manual `confidentialTransfer` after the Covenant opens. The source, the trust model, and the exact escrow/release/refund flow can be found in [`contracts/`](contracts/README.md).

## Architecture

zilch is a static single-page client plus a handful of stateless serverless functions (no database, no background workers, and no persisted state). Reading Covenants and building the Covenant calldata happen on the server; the confidential-token half happens entirely in the browser via Zama's v3 SDK, which the client bundles (viem + `@zama-fhe/sdk`, its FHE WebAssembly inlined at build time by Vite). The wallet is touched only to sign.

```
zilch/
├── api/                 Vercel serverless functions (thin adapters over src/server)
│   ├── feed.ts          GET  the sealed-transfer feed
│   ├── transfer.ts      GET  one sealed transfer in full
│   ├── tokens.ts        GET  the confidential token zilch is configured for
│   ├── seal.ts          POST build the Covenant post that seals an instruction
│   ├── keeper-tx.ts     POST build a reveal / settle transaction
│   └── config.ts        GET  settlement-hook address and atomic-mode flag
├── src/
│   ├── core/            pure, unit-tested logic (no chain, no I/O)
│   │   ├── instruction.ts  encode/decode the sealed instruction ↔ bytes
│   │   ├── transfer.ts     sealed / open / expired from Covenant state
│   │   ├── condition.ts    shape a trigger into a view model
│   │   └── format.ts       display formatting
│   ├── server/          RPC and the Blacklight L1 SDK (Covenant side only)
│   │   ├── chain.ts        viem client, addresses off C0, market log scans
│   │   ├── seal.ts         seal + price + encode a Covenant post
│   │   ├── transfers.ts    read Covenants as sealed transfers
│   │   ├── tokens.ts       confidential tokens, from Zama's registry
│   │   ├── decode.ts       decode a Covenant's condition record
│   │   └── http.ts         uniform JSON + error helpers
│   ├── client/          the browser SPA (bundles viem + @zama-fhe/sdk)
│   │   ├── app.ts          views, wallet, Zama shield/transfer/decrypt, settlement
│   │   ├── hookArtifact.ts compiled settlement-hook ABI + bytecode (deploy)
│   │   └── declarations.d.ts  ambient wallet (EIP-6963) types
│   └── shared/types.ts  the wire contract between client and server
├── contracts/           the one custom contract — the settlement hook
│   ├── src/ZilchSettlementHook.sol  escrow, release on reveal, refund
│   ├── compile.mjs      solc build → src/client/hookArtifact.ts
│   └── README.md        design, deployment, trust model
├── vite.config.ts       client build → public/build/ (WASM inlined)
└── public/              index.html, zilch.css, favicon.svg (build/ is generated)
```

The one address an integration pins is the Blacklight L1 `ProtocolConfig` proxy (**C0**, `0xa75716772c17818A73104344b5A8888ae24ADc03`); every other market address is resolved off it at runtime, so a superseded deployment can never be served from a stale address file. The confidential tokens are discovered from Zama's on-chain wrappers registry, or pinned by address.

| Contract                              | Ethereum mainnet address                     |
|---------------------------------------|----------------------------------------------|
| Blacklight `ProtocolConfig` (C0)      | `0xa75716772c17818A73104344b5A8888ae24ADc03` |
| Zama confidential-token registry      | `0xeb5015fF021DB115aCe010f23F55C2591059bBA0` |

## Running Locally

```shell
npm install
npm run build     # Vite builds the client into public/build/ (WASM inlined)
npm run dev:local # tsx dev server → http://localhost:3000
```

`npm run dev:local` serves `public/` (including the built client) and routes `/api/*` to the very same handler files Vercel runs, shimming the two request fields they read (`query`, `body`). During client work, `npm run build:watch` rebuilds `public/build/` on change. The read views need only an RPC endpoint; funding, sealing, settling, and keeper actions need a funded wallet on Ethereum mainnet. For a run that matches the deployed runtime exactly (including the WASM-bearing functions) use the [Vercel CLI](https://vercel.com/docs/cli): `vercel dev`.

## Deployment

zilch deploys to Vercel as a static site with serverless functions.

- **`.npmrc` sets `legacy-peer-deps=true`.** `@openzeppelin/confidential-contracts` pins an older `@fhevm/solidity` as a peer than the one used; the flag lets `npm install` resolve a flat, hoisted layout (which Vercel's function tracer and the SDK's WASM loader expect) without the peer conflict.
- **`vercel.json` ships the Blacklight L1 WASM.** The Blacklight L1 SDK instantiates a Node WASM module at import via a `readFileSync` path the tracer cannot infer, so `functions["api/*.ts"].includeFiles` explicitly bundles `node_modules/@nillion/covenants-sdk/dist/wasm/**`. Without it, every function 500s at cold start.
- **Relative imports carry `.js` extensions.** The package is an ES module and Vercel runs the functions as native Node ESM, which requires explicit extensions on relative specifiers. The client is exempt because Vite bundles it (into `public/build/`, with the Zama SDK's WASM inlined, so there are no `.wasm` assets to serve). Vercel's build command runs `npm run build`; the functions in `api/` are untouched by it.

Set `RPC_URL` to an authenticated mainnet provider for anything beyond light use; the public default is rate-limited and may prune logs. Point `CONFIG_ADDRESS` at a new C0 only if Blacklight L1 redeploys.

## Configuration

Every value has a working default; override via environment variables.

| Variable                  | Default                                        | Purpose                                        |
|---------------------------|------------------------------------------------|------------------------------------------------|
| `RPC_URL`                 | a public mainnet node                          | RPC endpoint for server reads and fee quotes   |
| `CONFIG_ADDRESS`          | `0xa757…ADc03` (C0)                            | the `ProtocolConfig` proxy address             |
| `SCAN_BLOCKS`             | `5000`                                         | how far back the feed's log scans look         |
| `ZILCH_REGISTRY`          | Zama's mainnet registry                        | the wrappers registry discovery reads          |
| `ZILCH_MAX_TOKENS`        | `24`                                            | how many registry entries to surface           |
| `ZILCH_CTOKEN` + `ZILCH_UNDERLYING` | *(unset)*                            | pin one specific pair, skipping registry discovery |
| `ZAMA_RELAYER_API_KEY`    | *(unset)*                                       | Zama mainnet relayer key; injected by the `/api/relayer` proxy |
| `ZILCH_HOOK`              | *(unset)*                                       | optional settlement-hook address; enables atomic mode |
| `ZILCH_HOOK_GAS`          | `3000000`                                       | gas budget for the reveal-time hook call       |

The confidential-token half runs on Zama's [v3 SDK](https://docs.zama.org/protocol/sdk) (`@zama-fhe/sdk`), bundled into the client. It targets the `mainnet` chain preset from `@zama-fhe/sdk/chains`, which carries Zama's mainnet relayer (`relayer.mainnet.zama.org`). Unlike the open testnet relayer, the **mainnet relayer requires a Zama API key** (an `x-api-key` header). zilch ships a server-side proxy at **`/api/relayer`** that injects the key, so the client points its relayer there and the key never enters the browser bundle. [Apply for a key](https://forms.gle/jq84zEek1oiv3kBz9), then set `ZAMA_RELAYER_API_KEY`; without it, the confidential-token operations fail on mainnet. Alternatively, **self-host the relayer** and point `ZAMA_RELAYER_URL` at it (then no Zama key is needed); set `RELAYER_TOKEN` to a shared secret the relayer's reverse proxy checks (the proxy sends it as `x-relayer-token`), and leave `ZAMA_RELAYER_API_KEY` unset. The SDK's FHE WebAssembly is inlined into the bundle at build time by Vite, so no `.wasm` files are served.

### Testing and Conventions

The pure core is unit-tested to full coverage with [vitest](https://vitest.dev/), and the boundary (import resolution and handler behaviour) is checked without a chain:
```shell
npm test                 # vitest, 100% coverage enforced on src/core
npm run typecheck        # tsc --noEmit
npm run lint             # biome check + ci
```
Style is enforced with [biomejs](https://biomejs.dev/). The core is deliberately free of chain and I/O so that the instruction codec, the outcome logic, and the trigger formatting are all tested directly; the server modules are exercised offline against an unreachable RPC to confirm every route returns clean JSON with the right status (a `400` for malformed input arrives before any RPC; a `502` when the chain is unreachable).

One thing this repository cannot do: exercise the on-chain flows. Posting a Covenant, revealing it, and the Zama shield/confidential-transfer/decrypt round-trip are live-network actions, so they are validated on a real mainnet deployment rather than in the test suite; the build is verified (a clean `vite build`), but WebAssembly instantiation and the live relayer round-trip are first-deploy checks. Expect a short iteration loop, and pin the `@zama-fhe/sdk` version that has been tested.

### Versioning

Version numbers follow [Semantic Versioning 2.0.0](https://semver.org/#semantic-versioning-200).

## Caveats

zilch is a **template**, not a product. It is not affiliated with or endorsed by Nillion or Zama. On mainnet it moves **real funds**, over an **unaudited** settlement hook. Exercise the full flow with trivial amounts and review the contract before relying on it. Its confidentiality rests on assumptions: the sealed instruction is protected only while fewer than *k* of the committee's *m* operators collude, and the amount's confidentiality rests on Zama's threshold KMS and its ACL. The [settlement hook](#the-settlement-hook) that binds the two halves is **unaudited**. It should be viewed as a reference to extend and harden, not a reviewed contract.
