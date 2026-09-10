# zilch

[![network](https://img.shields.io/badge/network-Sepolia-2b4bff)](https://sepolia.etherscan.io)
[![contracts](https://img.shields.io/badge/custom%20contracts-none-ffd400)](#no-custom-contracts)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A template dApp that pairs two confidentiality primitives on one payment: a [Zama](https://docs.zama.org/protocol) confidential token hides the **amount**, and a [Nillion Blacklight L1](https://docs.nillion.com) *Covenant* seals the **instruction** and opens it only when the price or the clock says so. It runs entirely on [Sepolia](https://sepolia.etherscan.io), in the browser and on [Vercel](https://vercel.com), with **no custom contracts** — only Zama's already-deployed ERC-7984 tokens and the Blacklight L1 network.

## What zilch Does

Much of the recent work on private transactions encrypts one thing: *how much value moved*. Covenants encrypt an orthogonal thing — the *instruction*, and (later in Nillion's roadmap) the *condition* under which that sealed instruction is allowed to open and execute. Neither alone conceals a whole transfer; together they cover each other's gap. **zilch** is a minimal demonstration of that pairing: you compose a payment, the amount is encrypted in your browser and never leaves it in the clear, and the instruction — who is paid, in which token, with what memo — is sealed into a Covenant that publishes only its *trigger* and opens itself when that trigger fires.

The result is a transfer whose timing and instruction were a sealed envelope that opened on cue, and whose amount was and remains concealed by the token's value machinery. That is the line from Choose K's write-up made concrete: *"the value layer hides the magnitude a Covenant alone might otherwise need to reveal, and the Covenant seals the queued instruction which the value layer leaves exposed."*

## How a Sealed Transfer Works

A **sealed transfer** is a Covenant whose sealed payload is a transfer instruction and whose release condition is a price or time trigger. It can only end two ways, both public and both settled by the staked committee rather than an oracle, so its state is a pure function of what the chain already exposes:

| State     | What it means                                                     | The on-chain fact behind it                       |
|-----------|-------------------------------------------------------------------|---------------------------------------------------|
| `sealed`  | The trigger has not fired; the instruction is hidden.             | The Covenant is unresolved and before its deadline. |
| `open`    | The trigger fired; the instruction is revealed and ready to settle. | The Covenant resolved — a `TriggerResolved` event carries the plaintext. |
| `expired` | The deadline passed untriggered; it settles to nothing (*zilch*). | The Covenant is unresolved and past its deadline.  |

When a transfer opens, the committee's reconstruction makes the instruction public — but the amount is never part of it. The amount lives only in Zama's ciphertext, so opening the envelope reveals *who* and *what*, never *how much*.

## Two Primitives

Each primitive conceals exactly what the other would expose:

| Attribute                          | Concealed by                                          | Public                          |
|------------------------------------|-------------------------------------------------------|---------------------------------|
| Amount                             | Zama ERC-7984 — an encrypted `euint64` balance handle | that *a* transfer occurred      |
| Instruction (recipient, token, memo) | Covenant — the sealed payload                       | the trigger (a price or a time) |
| Condition                          | public here; sealable in Nillion's later *Neon* phase | —                               |

**The instruction half (Covenant).** A Covenant seals bytes to a *k*-of-*m* committee, publishes a release condition, and lets the committee open the payload when the condition fires. zilch seals a compact instruction — a magic header, the recipient, the token, an optional amount commitment, and a memo — with a public price condition, so the trigger is legible in the feed while the instruction stays sealed until it opens.

**The amount half (Zama).** ERC-7984 mirrors ERC-20 but every balance and transfer amount is a ciphertext handle; the contract adds and subtracts without seeing the numbers. zilch encrypts the amount in the browser with Zama's [relayer SDK](https://docs.zama.org/protocol), hands the wallet a handle plus an input proof, and the recipient later reads their new balance with an [EIP-712](https://eips.ethereum.org/EIPS/eip-712) decryption permit that only their wallet can sign. Nothing but ciphertext touches the chain, and nothing but the wallet-held permit can decrypt it.

## Workflow Overview

Everything below is a browser action against deployed contracts, signed by your wallet. The server never holds a key, ETH, or NIL.

1. **Fund.** Publicly mint the mock underlying ([USDC mock](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF)), approve the wrapper, and wrap into a confidential [cUSDC](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) balance. Read the balance back — only you can decrypt it.
2. **Seal.** Compose `{recipient, amount, trigger, deadline, memo}`. The amount stays in your browser; the instruction is sealed into a Covenant via `/api/seal`, and your wallet posts it (paying the Covenant escrow, the NIL protocol fee, and gas — you are the author of record).
3. **Watch.** The feed shows sealed transfers counting down toward their triggers.
4. **Open.** When the trigger fires, the committee resolves the Covenant and the instruction opens. If it lingers, anyone can reveal it — reconstructing from the posted shares — for the reconstructor fee.
5. **Settle.** Send the ERC-7984 confidential transfer: the amount is encrypted in your browser and stays concealed on-chain forever. The recipient decrypts their balance privately.

## No Custom Contracts

zilch deliberately deploys nothing of its own. Zama's persistence — the fact that any decryptable encrypted value must pass through a deployed FHEVM contract with the right [ACL](https://docs.zama.org/protocol) grants — is satisfied by driving Zama's *already-deployed* Sepolia tokens, whose mock underlying has a public `mint`. The Covenant half needs no contract at all: sealing, posting, reading, revealing, and settling are all calls to the standing Blacklight L1 network.

There is exactly one honest cost to owning no contract: **settlement is not atomic.** A Covenant cannot itself call `confidentialTransfer` when it opens — that bridge is a *hook*, and a hook is a contract. So in zilch the Covenant opening reveals the instruction, and the confidential transfer is a second, browser-signed step at settlement. Everything else is complete. A roughly thirty-line settlement hook (an `onReveal` that pulls a pre-authorised confidential transfer) is the upgrade that makes it atomic; the demo stands on its own without it, and this is the only place a contract would change the shape of the flow.

## Architecture

zilch is a static single-page client plus a handful of stateless serverless functions — no database, no background workers, no persisted state. Reading Covenants and building calldata happen on the server (which holds every ABI); encrypting and decrypting the amount happen only in the browser (via Zama's SDK, loaded from a CDN and never bundled); the wallet is touched only to sign.

```
zilch/
├── api/                 Vercel serverless functions (thin adapters over src/server)
│   ├── feed.ts          GET  the sealed-transfer feed
│   ├── transfer.ts      GET  one sealed transfer in full
│   ├── tokens.ts        GET  the confidential tokens zilch can use
│   ├── balance.ts       GET  an account's confidential balance handle
│   ├── seal.ts          POST build the Covenant post that seals an instruction
│   ├── tx.ts            POST build a faucet / approve / wrap / confidential-send tx
│   └── keeper-tx.ts     POST build a reveal / settle transaction
├── src/
│   ├── core/            pure, unit-tested logic (no chain, no I/O)
│   │   ├── instruction.ts  encode/decode the sealed instruction ↔ bytes
│   │   ├── transfer.ts     sealed / open / expired from Covenant state
│   │   ├── condition.ts    shape a trigger into a view model
│   │   └── format.ts       display formatting
│   ├── server/          RPC, the Blacklight L1 SDK, and calldata (holds the ABIs)
│   │   ├── chain.ts        viem client, addresses off C0, market log scans
│   │   ├── seal.ts         seal + price + encode a Covenant post
│   │   ├── transfers.ts    read Covenants as sealed transfers
│   │   ├── tokens.ts       Zama token config, calldata, balance reads
│   │   ├── decode.ts       decode a Covenant's condition record
│   │   └── http.ts         uniform JSON + error helpers
│   ├── client/          the browser SPA (ships no ABIs, no crypto library)
│   │   ├── app.ts          views, wallet, Zama encrypt/decrypt, settlement
│   │   └── declarations.d.ts  ambient types for the wallet and Zama globals
│   └── shared/types.ts  the wire contract between client and server
└── public/              index.html, zilch.css, favicon.svg, built app.js
```

The one address an integration pins is the Blacklight L1 `ProtocolConfig` proxy (**C0**, `0xebB338689fB32317DDFD8282F8a42dcA6271cB2d`); every other market address is resolved off it at runtime, so a superseded deployment can never be served from a stale address file. The confidential token is likewise a single configurable address.

| Contract                              | Sepolia address                              |
|---------------------------------------|----------------------------------------------|
| Confidential USDC (ERC-7984 wrapper)  | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` |
| Mock USDC (public `mint`)             | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` |
| Blacklight L1 `ProtocolConfig` (C0)   | `0xebB338689fB32317DDFD8282F8a42dcA6271cB2d` |

## Running Locally

Use of [pnpm](https://pnpm.io/) is recommended.

```shell
pnpm install
pnpm build        # bundle the SPA into public/app.js (script: build)
pnpm dev:local    # tsx dev server → http://localhost:3000
```

`pnpm dev:local` serves `public/` and routes `/api/*` to the very same handler files Vercel runs, shimming the two request fields they read (`query`, `body`). The read views need only an RPC endpoint; funding, sealing, settling, and keeper actions need a wallet on Sepolia. For a run that matches the deployed runtime exactly — including the WASM-bearing functions — use the [Vercel CLI](https://vercel.com/docs/cli): `vercel dev`.

## Deployment

zilch deploys to Vercel as a static site with serverless functions.

- **`.npmrc` pins `node-linker=hoisted`.** pnpm's default symlinked `node_modules` breaks Vercel's function file tracing and `includeFiles`; a hoisted, flat layout is what the tracer and the SDK's WASM loader expect.
- **`vercel.json` ships the Blacklight L1 WASM.** The Blacklight L1 SDK instantiates a Node WASM module at import via a `readFileSync` path the tracer cannot infer, so `functions["api/*.ts"].includeFiles` explicitly bundles `node_modules/@nillion/blacklight-l1-sdk/dist/wasm/**`. Without it, every function 500s at cold start.
- **Relative imports carry `.js` extensions.** The package is an ES module and Vercel runs the functions as native Node ESM, which requires explicit extensions on relative specifiers. The client is exempt only because esbuild bundles it.

Set `SEPOLIA_RPC_URL` to an authenticated provider for anything beyond light use; the public default is rate-limited. Point `BLACKLIGHT_CONFIG` at a new C0 only if Blacklight L1 redeploys.

## Configuration

Every value has a working default; override via environment variables.

| Variable                  | Default                                        | Purpose                                        |
|---------------------------|------------------------------------------------|------------------------------------------------|
| `SEPOLIA_RPC_URL`         | a public Sepolia node                          | RPC endpoint for server reads and fee quotes   |
| `BLACKLIGHT_CONFIG`       | `0xebB3…cB2d` (C0)                             | the `ProtocolConfig` proxy address             |
| `SCAN_BLOCKS`             | `5000`                                         | how far back the feed's log scans look         |
| `ZILCH_CTOKEN`            | `0x7c5B…3639` (cUSDC)                          | the confidential ERC-7984 token                |
| `ZILCH_UNDERLYING`        | `0x9b5C…dFfF` (mock USDC)                      | its ERC-20 underlying (the faucet target)      |
| `ZILCH_TOKEN_SYMBOL`      | `cUSDC`                                         | display symbol for the confidential token      |
| `ZILCH_UNDERLYING_SYMBOL` | `USDC`                                          | display symbol for the underlying              |
| `ZILCH_TOKEN_DECIMALS`    | `6`                                             | decimals for amount formatting                 |

The browser loads Zama's relayer SDK from a CDN `<script>` in `public/index.html`. Verify the exact version and URL against Zama's current *Using the CDN* documentation when you deploy; the client degrades with a clear message if the SDK fails to load.

## Development

### Testing and Conventions

The pure core is unit-tested to full coverage with [vitest](https://vitest.dev/), and the boundary — import resolution and handler behaviour — is checked without a chain:

```shell
pnpm test                # vitest, 100% coverage enforced on src/core
pnpm typecheck           # tsc --noEmit
pnpm lint                # biome check + ci
```

Style is enforced with [biomejs](https://biomejs.dev/). The core is deliberately free of chain and I/O so that the instruction codec, the outcome logic, and the trigger formatting are all tested directly; the server modules are exercised offline against an unreachable RPC to confirm every route returns clean JSON with the right status (a `400` for malformed input arrives before any RPC; a `502` when the chain is unreachable).

One thing this repository cannot do for you: exercise the on-chain flows. Posting a Covenant, revealing it, and the Zama encrypt / transfer / decrypt round-trip are live-network actions, so they are validated on a real Sepolia deployment rather than in the test suite. Expect a short iteration loop on first deploy, and verify the Zama SDK's CDN URL and the exact `userDecrypt` permit signature against Zama's current docs.

### Versioning

Version numbers follow [Semantic Versioning 2.0.0](https://semver.org/#semantic-versioning-200).

## What This Is Not

zilch is a **template on a testnet**, not a product. It is not affiliated with or endorsed by Nillion or Zama. It handles test funds only. Its confidentiality rests on assumptions: the sealed instruction is protected only while fewer than *k* of the committee's *m* operators collude, and the amount's confidentiality rests on Zama's threshold KMS and its ACL. Settlement is not atomic without the hook described [above](#no-custom-contracts). And because the amount is applied at settlement rather than bound on-chain at seal time, the optional amount commitment in the instruction is advisory in this template — a contract would be needed to enforce it. None of these is hidden in the interface.

## License

[MIT](./LICENSE).
