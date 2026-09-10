/**
 * zilch — the browser client.
 *
 * A single-page app over the sealed-transfer feed and one transfer's detail
 * (both wallet-free reads), plus the flows that touch a wallet: funding a
 * confidential balance, sealing a transfer into a Covenant, and settling one
 * once it opens. Reads talk only to the `/api` routes, which return preformatted
 * JSON. The confidential amount is handled entirely in the browser by Zama's v3
 * SDK (`@zama-fhe/sdk`, bundled), whose `WrappedToken` shields, transfers, and
 * decrypts without the amount ever reaching the server or appearing on-chain in
 * the clear. The wallet is discovered via EIP-6963, so MetaMask, Rainbow, and any
 * other conforming wallet all work.
 */

import { ZamaSDK } from "@zama-fhe/sdk";
import { sepolia as sepoliaFhe } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { web } from "@zama-fhe/sdk/web";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
} from "viem";
import { sepolia } from "viem/chains";
import {
  escapeHtml,
  formatDateUtc,
  formatDuration,
  relativeTime,
  truncateAddress,
} from "../core/format.js";
import type {
  ConfigResponse,
  FeedResponse,
  KeeperAction,
  KeeperTxResponse,
  SealedTransfer,
  SealResponse,
  TimelineEntry,
  TokenPair,
  TokensResponse,
  TransferDetail,
  Tx,
} from "../shared/types.js";
import { HOOK_ABI, HOOK_BYTECODE } from "./hookArtifact.js";

/* ------------------------------------------------------------------ */
/* Constants and small helpers                                        */
/* ------------------------------------------------------------------ */

const SEPOLIA_HEX = "0xaa36a7"; // 11155111
const EXPLORER = "https://sepolia.etherscan.io";
const REFRESH_MS = 12000; // Sepolia's ~12s block time

/** Chain time minus local time, learned at each fetch, so countdowns tick
 *  against the chain's clock rather than the browser's. */
let clockOffset = 0;

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing element #${id}`);
  }
  return element;
}

function chainNow(): number {
  return Math.floor(Date.now() / 1000) + clockOffset;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? response.statusText);
  }
  return body;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? response.statusText);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Amount helpers (the amount lives only here)                        */
/* ------------------------------------------------------------------ */

/** Parse a human amount ("100", "12.5") into base units for `decimals`. Throws
 *  on anything that is not a clean non-negative decimal. */
function toBaseUnits(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("amount must be a non-negative decimal");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`at most ${decimals} decimal places`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Render base units as a human amount, trimming trailing zeros. */
function fromBaseUnits(base: string | bigint, decimals: number): string {
  const value = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const frac = (value % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* ------------------------------------------------------------------ */
/* Zama v3 SDK (bundled; talks to the open Sepolia relayer)           */
/* ------------------------------------------------------------------ */

/** A confidential-token wrapper handle, as returned by `createWrappedToken`. */
type Wrapped = ReturnType<InstanceType<typeof ZamaSDK>["createWrappedToken"]>;

/** The minimal ABI for the mock underlying's public faucet mint. */
const MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const SET_OPERATOR_ABI = [
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "until", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`config ${res.status}`);
  }
  return (await res.json()) as ConfigResponse;
}

let configCache: ConfigResponse | null = null;
/** Memoized `/api/config`, so compose and the detail view can check atomic mode
 *  without refetching on every render. */
async function cachedConfig(): Promise<ConfigResponse> {
  if (!configCache) {
    configCache = await getConfig();
  }
  return configCache;
}

/** A fresh 32-byte escrow id as a 0x-prefixed hex string. */
function randomId(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A viem wallet client backed by the connected EIP-1193 provider. Used for the
 *  faucet mint and, inside the SDK config, for confidential writes. */
function makeWalletClient() {
  if (!wallet.provider || !wallet.account) {
    throw new Error("connect a wallet first");
  }
  return createWalletClient({
    account: wallet.account as `0x${string}`,
    chain: sepolia,
    transport: custom(wallet.provider),
  });
}

/** Wait for a submitted transaction to be mined, so a dependent transaction is
 *  estimated against the updated chain state (e.g. post after a NIL approval). */
async function waitForReceipt(hash: string) {
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(),
  });
  return await publicClient.waitForTransactionReceipt({
    hash: hash as `0x${string}`,
  });
}

let sdkReady: Promise<ZamaSDK> | null = null;
let sdkAccountKey: string | null = null;

/**
 * Build the Zama SDK once for the connected wallet, rebuilding if the account
 * changes. The wallet's provider backs a viem wallet client; reads use a public
 * Sepolia client. The `sepolia` chain preset carries the current, open testnet
 * relayer (`relayer.testnet.zama.org/v2`), so no API key or proxy is needed.
 */
async function getSdk(): Promise<ZamaSDK> {
  if (!wallet.provider || !wallet.account) {
    throw new Error("connect a wallet first");
  }
  const key = wallet.account.toLowerCase();
  if (sdkReady && sdkAccountKey === key) {
    return sdkReady;
  }
  sdkAccountKey = key;
  const walletClient = makeWalletClient();
  sdkReady = (async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(),
    });
    const config = createConfig({
      chains: [sepoliaFhe],
      publicClient,
      walletClient,
      relayers: { [sepoliaFhe.id]: web() },
    });
    return new ZamaSDK(config);
  })();
  return sdkReady;
}

/** A memoised `WrappedToken` for one confidential-token address. */
let wrappedCache: { key: string; wrapped: Wrapped } | null = null;

async function getWrapped(tokenAddr: string): Promise<Wrapped> {
  const sdk = await getSdk();
  const key = `${sdkAccountKey}:${tokenAddr.toLowerCase()}`;
  if (wrappedCache && wrappedCache.key === key) {
    return wrappedCache.wrapped;
  }
  const wrapped = sdk.createWrappedToken(tokenAddr as `0x${string}`);
  wrappedCache = { key, wrapped };
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

let tokenCache: TokenPair | null = null;

async function token(): Promise<TokenPair> {
  if (tokenCache) {
    return tokenCache;
  }
  const data = await getJson<TokensResponse>("/api/tokens");
  const first = data.tokens[0];
  if (!first) {
    throw new Error("no confidential token configured");
  }
  tokenCache = first;
  return first;
}

/* ------------------------------------------------------------------ */
/* Rendering pieces                                                   */
/* ------------------------------------------------------------------ */

function badge(outcome: string): string {
  const label =
    outcome === "open" ? "OPEN" : outcome === "expired" ? "EXPIRED" : "SEALED";
  return `<span class="badge ${outcome}">${label}</span>`;
}

function addrLink(address: string | null): string {
  if (!address) {
    return '<span class="muted">—</span>';
  }
  return `<a class="mono" href="${EXPLORER}/address/${address}" target="_blank" rel="noreferrer">${truncateAddress(address)}</a>`;
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function countdown(deadline: number, now: number): string {
  const left = deadline - now;
  if (left <= 0) {
    return "deadline passed";
  }
  return `${formatDuration(left)} until it expires`;
}

/** The signature fuse: a bar that fills toward the deadline, plus a status line
 *  the tick loop advances in place for still-sealed transfers. */
function fuse(t: {
  outcome: string;
  postedAt: number | null;
  resolvedAt: number | null;
  deadline: number;
}): string {
  const now = chainNow();
  const posted = t.postedAt ?? t.deadline;
  const span = Math.max(1, t.deadline - posted);
  if (t.outcome === "open") {
    const at = t.resolvedAt ?? posted;
    const pct = clampPct(((at - posted) / span) * 100);
    return `<div class="fuse open"><div class="burn" style="width:${pct}%"></div><i class="spark" style="left:${pct}%"></i></div>
      <div class="fuseline open">opened ${relativeTime(at, now)} — trigger fired</div>`;
  }
  if (t.outcome === "expired") {
    return `<div class="fuse expired"><div class="burn" style="width:100%"></div></div>
      <div class="fuseline expired">deadline passed — settled to nothing</div>`;
  }
  const pct = clampPct(((now - posted) / span) * 100);
  return `<div class="fuse sealed"><div class="burn" style="width:${pct}%"></div><i class="spark" style="left:${pct}%"></i></div>
    <div class="fuseline sealed" data-deadline="${t.deadline}">${countdown(t.deadline, now)}</div>`;
}

/** The redaction strip shown for a still-sealed instruction. */
function redaction(): string {
  return `<div class="redact"><span class="bar"></span><span class="bar b2"></span><span class="bar b3"></span>
    <span class="rlabel">sealed — opens at the trigger</span></div>`;
}

/* ------------------------------------------------------------------ */
/* Feed view                                                          */
/* ------------------------------------------------------------------ */

let currentId: string | null = null;

async function loadFeed(options: { silent?: boolean } = {}): Promise<void> {
  currentId = null;
  const view = $("view");
  if (!options.silent) {
    view.innerHTML = `<div class="loading">Reading the feed…</div>`;
  }
  try {
    const data = await getJson<FeedResponse>("/api/feed?limit=50");
    clockOffset = data.nowUnix - Math.floor(Date.now() / 1000);
    view.innerHTML = feedHtml(data);
    for (const card of view.querySelectorAll<HTMLElement>("[data-goid]")) {
      card.addEventListener("click", () =>
        go(`?id=${card.getAttribute("data-goid")}`),
      );
    }
    startFeedAuto();
  } catch (error) {
    view.innerHTML = errorHtml("Could not read the feed", error);
  }
}

function feedHtml(data: FeedResponse): string {
  const rows = data.transfers.map(transferCard).join("");
  return `
    <section class="hero">
      <div class="hero-copy">
        <h1>Sealed <span class="hl">Confidential</span> Transfers</h1>
        <p>Payments whose <b>amounts are invisible</b> and whose <b>instructions are sealed
        envelopes</b> that open only when the market or the clock dictates to do so.</p>
      </div>
      <div class="tally">
        <div class="t"><span class="n">${data.counts.sealed}</span><span class="l">sealed</span></div>
        <div class="t"><span class="n">${data.counts.open}</span><span class="l">open</span></div>
        <div class="t"><span class="n">${data.counts.expired}</span><span class="l">expired</span></div>
      </div>
    </section>
    <div class="bar-actions">
      <button class="btn ghost" id="fund-2">Fund a Balance</button>
      <button class="btn solid" id="new-2">Seal a Transfer</button>
      <span class="stamp" id="stamp"></span>
    </div>
    <div class="feed">${rows || '<div class="empty">No sealed transfers yet. Seal the first one.</div>'}</div>`;
}

function transferCard(t: SealedTransfer): string {
  const who =
    t.outcome === "open" && t.instruction
      ? `pay ${addrLink(t.instruction.recipient)}${t.instruction.tokenSymbol ? ` · ${escapeHtml(t.instruction.tokenSymbol)}` : ""}`
      : "recipient sealed";
  return `<article class="card" data-goid="${escapeHtml(t.id)}">
    <div class="card-top">
      <span class="tid mono">#${escapeHtml(t.id)}</span>
      ${badge(t.outcome)}
    </div>
    <div class="trigger">${escapeHtml(t.condition.text)}</div>
    <div class="who">${who}</div>
    ${fuse(t)}
    <div class="card-foot mono">${t.k}-of-${t.m} committee · by ${addrLink(t.author)}</div>
  </article>`;
}

/* ------------------------------------------------------------------ */
/* Transfer detail view                                               */
/* ------------------------------------------------------------------ */

async function loadTransfer(
  id: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  currentId = id;
  const view = $("view");
  if (!options.silent) {
    view.innerHTML = `<div class="loading">Reading transfer #${escapeHtml(id)}…</div>`;
  }
  try {
    const t = await getJson<TransferDetail>(
      `/api/transfer?id=${encodeURIComponent(id)}`,
    );
    clockOffset = 0; // detail carries no now; keep local clock
    view.innerHTML = transferHtml(t);
    wireTransfer(t);
    startTransferAuto(id);
  } catch (error) {
    view.innerHTML = errorHtml(`Could not read transfer #${id}`, error);
  }
}

function transferHtml(t: TransferDetail): string {
  const revealed =
    t.outcome === "open" && t.instruction
      ? instructionPanel(t.instruction)
      : t.outcome === "expired"
        ? `<div class="ipanel expired"><div class="ilabel">Instruction</div>
           <p class="muted">This transfer expired before its trigger fired. It settled to nothing — the instruction stays sealed for good.</p></div>`
        : `<div class="ipanel sealed"><div class="ilabel">Instruction</div>${redaction()}</div>`;

  const escrowId =
    t.instruction?.amountCommitment ?? readStash(t.commit)?.escrowId ?? null;
  const settle = escrowId
    ? atomicPanel(escrowId, t.outcome)
    : t.outcome === "open" && t.instruction
      ? settlePanel(t)
      : "";

  const spot = t.spotUsd
    ? `<div class="kv"><span class="k">Spot now</span><span class="v mono">${escapeHtml(t.spotUsd)}</span></div>`
    : "";

  return `
    <a class="back" href="?" id="back">← all transfers</a>
    <section class="detail-head">
      <div>
        <div class="tid mono big">#${escapeHtml(t.id)}</div>
        <div class="trigger big">${escapeHtml(t.condition.text)}</div>
      </div>
      ${badge(t.outcome)}
    </section>
    ${fuse(t)}
    ${revealed}
    ${settle}
    <section class="grid2">
      <div class="ipanel">
        <div class="ilabel">Covenant</div>
        <div class="kv"><span class="k">Committee</span><span class="v mono">${t.k}-of-${t.m}</span></div>
        <div class="kv"><span class="k">Shares posted</span><span class="v mono">${t.sharesPosted}</span></div>
        <div class="kv"><span class="k">Author</span><span class="v">${addrLink(t.author)}</span></div>
        <div class="kv"><span class="k">Deadline</span><span class="v mono">${formatDateUtc(t.deadline)}</span></div>
        ${spot}
        <div class="kv"><span class="k">Commit</span><span class="v mono tiny">${escapeHtml(truncateAddress(t.commit))}</span></div>
        ${t.postTx ? `<div class="kv"><span class="k">Posted in</span><a class="v mono" href="${EXPLORER}/tx/${t.postTx}" target="_blank" rel="noreferrer">${truncateAddress(t.postTx)}</a></div>` : ""}
      </div>
      <div class="ipanel">
        <div class="ilabel">Committee slots</div>
        ${committeeHtml(t)}
      </div>
    </section>
    <section class="ipanel">
      <div class="ilabel">Timeline</div>
      ${timelineHtml(t.timeline)}
    </section>
    ${keeperHtml(t)}`;
}

function instructionPanel(instruction: {
  recipient: string;
  token: string;
  tokenSymbol: string | null;
  memo: string | null;
}): string {
  return `<section class="ipanel open">
    <div class="ilabel">Instruction — <span class="opened">opened</span></div>
    <div class="kv"><span class="k">Pay</span><span class="v">${addrLink(instruction.recipient)}</span></div>
    <div class="kv"><span class="k">Token</span><span class="v">${addrLink(instruction.token)}${instruction.tokenSymbol ? ` <span class="mono">${escapeHtml(instruction.tokenSymbol)}</span>` : ""}</span></div>
    <div class="kv"><span class="k">Amount</span><span class="v muted">encrypted — set at settlement, never public</span></div>
    ${instruction.memo ? `<div class="kv"><span class="k">Memo</span><span class="v">${escapeHtml(instruction.memo)}</span></div>` : ""}
  </section>`;
}

function settlePanel(t: TransferDetail): string {
  const stash = readStash(t.commit);
  const prefill = stash ? escapeHtml(stash.amount) : "";
  const sym = t.instruction?.tokenSymbol ?? "tokens";
  return `<section class="settle">
    <div class="ilabel">Settle — send the confidential amount</div>
    <p class="muted">The trigger fired and the instruction opened. Send the confidential
    transfer now: the amount is encrypted in your browser and stays concealed on-chain.</p>
    <div class="settle-row">
      <input id="settle-amount" class="in" inputmode="decimal" placeholder="amount in ${escapeHtml(sym)}" value="${prefill}" />
      <button class="btn solid" id="settle-btn">Encrypt &amp; send</button>
    </div>
    <div class="status" id="settle-status"></div>
  </section>`;
}

/** For atomic transfers: a panel that reads the hook's escrow state and, while
 *  the escrow is still held, offers the sender a refund. It never renders a
 *  manual settle control — the hook releases the amount on reveal. */
function atomicPanel(escrowId: string, outcome: string): string {
  return `<section class="settle" id="atomic-panel" data-escrow="${escapeHtml(escrowId)}" data-outcome="${escapeHtml(outcome)}">
    <div class="ilabel">Atomic settlement</div>
    <p class="muted">This transfer's amount is escrowed in the settlement hook and is released to the
    recipient inside the covenant's reveal transaction — there is no manual settlement step.</p>
    <div class="status" id="atomic-status">Checking escrow…</div>
    <div id="atomic-actions"></div>
  </section>`;
}

async function hydrateEscrow(escrowId: string, outcome: string): Promise<void> {
  const statusEl = document.getElementById("atomic-status");
  const actionsEl = document.getElementById("atomic-actions");
  if (!statusEl || !actionsEl) {
    return;
  }
  let hook: string | null = null;
  try {
    hook = (await cachedConfig()).hook;
  } catch {
    // fall through to the not-configured message
  }
  if (!hook || !isAddress(hook)) {
    statusEl.textContent =
      "No settlement hook is configured here, so the escrow state can't be read.";
    return;
  }
  try {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(),
    });
    const state = Number(
      await publicClient.readContract({
        address: hook as `0x${string}`,
        abi: HOOK_ABI,
        functionName: "escrowState",
        args: [escrowId as `0x${string}`],
      }),
    );
    // 0 none · 1 escrowed · 2 released · 3 refunded
    if (state === 2) {
      statusEl.innerHTML =
        "✓ Settled atomically on reveal — the confidential amount was released to the recipient.";
    } else if (state === 3) {
      statusEl.textContent =
        "Refunded — the escrowed amount was returned to the sender.";
    } else if (state === 1) {
      statusEl.textContent =
        outcome === "open"
          ? "Escrowed but not yet released. If the reveal did not release it, the sender can refund below."
          : "Amount escrowed, awaiting the covenant. The sender can refund below at any time.";
      actionsEl.innerHTML = `<button class="btn ghost" id="refund-btn">Refund to sender</button>
        <div class="status" id="refund-status"></div>`;
      document
        .getElementById("refund-btn")
        ?.addEventListener(
          "click",
          () => void doRefund(escrowId, hook as string),
        );
    } else {
      statusEl.textContent =
        "No escrow found for this transfer — the escrow step may not have completed at seal time.";
    }
  } catch (error) {
    statusEl.textContent = message(error);
  }
}

async function doRefund(escrowId: string, hook: string): Promise<void> {
  const status = document.getElementById("refund-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    if (status) {
      status.textContent = "Confirm the refund in your wallet…";
    }
    const walletClient = makeWalletClient();
    const hash = await walletClient.writeContract({
      address: hook as `0x${string}`,
      abi: HOOK_ABI,
      functionName: "refund",
      args: [escrowId as `0x${string}`],
    });
    if (status) {
      status.innerHTML = txDone("Refunded", hash);
    }
  } catch (error) {
    if (status) {
      status.textContent = message(error);
    }
  }
}

function committeeHtml(t: TransferDetail): string {
  if (!t.committee.length) {
    return `<p class="muted">No committee slots recorded.</p>`;
  }
  return `<div class="slots">${t.committee
    .map(
      (slot) =>
        `<div class="slot ${slot.shared ? "on" : ""}"><span class="mono">#${slot.slot}</span>
        <span class="mono tiny">${slot.nodeId ? `node ${escapeHtml(slot.nodeId)}` : `key ${escapeHtml(truncateAddress(slot.keyId))}`}</span>
        <span class="dot">${slot.shared ? "share in" : "waiting"}</span></div>`,
    )
    .join("")}</div>`;
}

function timelineHtml(timeline: TimelineEntry[]): string {
  if (!timeline.length) {
    return `<p class="muted">No events yet.</p>`;
  }
  return `<ol class="timeline">${timeline
    .map(
      (entry) =>
        `<li><span class="ev">${escapeHtml(entry.type)}</span>
        <a class="mono tiny" href="${EXPLORER}/tx/${entry.txHash}" target="_blank" rel="noreferrer">block ${entry.block}</a></li>`,
    )
    .join("")}</ol>`;
}

function keeperHtml(t: TransferDetail): string {
  if (t.outcome === "open") {
    return "";
  }
  const action: KeeperAction = t.outcome === "expired" ? "settle" : "reveal";
  const label =
    t.outcome === "expired"
      ? "Settle the expired Covenant"
      : "Reveal — reconstruct and open now";
  const help =
    t.outcome === "expired"
      ? "Close out the expired transfer and release the Covenant escrow."
      : "If enough shares are posted, anyone can reconstruct the instruction and open it — earning the reconstructor fee.";
  return `<section class="keeper">
    <div class="ilabel">Keeper</div>
    <p class="muted">${help}</p>
    <button class="btn ghost" id="keeper-btn" data-action="${action}">${label}</button>
    <div class="status" id="keeper-status"></div>
  </section>`;
}

function wireTransfer(t: TransferDetail): void {
  $("back").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  const settleBtn = document.getElementById("settle-btn");
  if (settleBtn && t.instruction) {
    const instruction = t.instruction;
    settleBtn.addEventListener("click", () => void doSettle(t, instruction));
  }
  const atomicPanelEl = document.getElementById("atomic-panel");
  if (atomicPanelEl) {
    const escrowId = atomicPanelEl.getAttribute("data-escrow") ?? "";
    const outcome = atomicPanelEl.getAttribute("data-outcome") ?? "";
    if (escrowId) {
      void hydrateEscrow(escrowId, outcome);
    }
  }
  const keeperBtn = document.getElementById("keeper-btn");
  if (keeperBtn) {
    keeperBtn.addEventListener(
      "click",
      () =>
        void keeperAction(
          keeperBtn.getAttribute("data-action") as KeeperAction,
          t.id,
        ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Fund view                                                          */
/* ------------------------------------------------------------------ */

async function renderFund(): Promise<void> {
  currentId = null;
  stopAuto();
  const view = $("view");
  view.innerHTML = `<div class="loading">Loading tokens…</div>`;
  let pair: TokenPair;
  try {
    pair = await token();
  } catch (error) {
    view.innerHTML = errorHtml("Could not load tokens", error);
    return;
  }
  view.innerHTML = `
    <a class="back" href="?" id="back">← all transfers</a>
    <h2 class="ph">Fund Confidential Balance</h2>
    <p class="muted wide">Three steps leveraging Zama's already-deployed Sepolia contracts.
    Mint the mock underlying, wrap it into a confidential <b>${escapeHtml(pair.symbol)}</b> balance, then read your
    balance back (something only you can do).</p>
    <div class="grid3">
      <div class="ipanel">
        <div class="step">1</div><div class="ilabel">Faucet</div>
        <p class="muted">Public mint of the mock ${escapeHtml(pair.underlyingSymbol)}.</p>
        <input id="faucet-amount" class="in" inputmode="decimal" placeholder="e.g. 1000" value="1000" />
        <button class="btn solid" id="faucet-btn">Mint ${escapeHtml(pair.underlyingSymbol)}</button>
        <div class="status" id="faucet-status"></div>
      </div>
      <div class="ipanel">
        <div class="step">2</div><div class="ilabel">Wrap</div>
        <p class="muted">Approve, then wrap into confidential ${escapeHtml(pair.symbol)}.</p>
        <input id="wrap-amount" class="in" inputmode="decimal" placeholder="e.g. 250" value="250" />
        <button class="btn solid" id="wrap-btn">Approve &amp; wrap</button>
        <div class="status" id="wrap-status"></div>
      </div>
      <div class="ipanel">
        <div class="step">3</div><div class="ilabel">Balance</div>
        <p class="muted">Decrypt your ${escapeHtml(pair.symbol)} balance with an EIP-712 permit.</p>
        <button class="btn ghost" id="bal-btn">Decrypt my balance</button>
        <div class="bal" id="bal-out"></div>
        <div class="status" id="bal-status"></div>
      </div>
    </div>`;
  $("back").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  $("faucet-btn").addEventListener("click", () => void doFaucet(pair));
  $("wrap-btn").addEventListener("click", () => void doWrap(pair));
  $("bal-btn").addEventListener("click", () => void doDecryptBalance(pair));
}

async function doFaucet(pair: TokenPair): Promise<void> {
  const status = $("faucet-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    const amount = toBaseUnits(
      ($("faucet-amount") as HTMLInputElement).value,
      pair.decimals,
    );
    status.textContent = `Minting ${pair.underlyingSymbol}…`;
    const walletClient = makeWalletClient();
    const hash = await walletClient.writeContract({
      address: pair.underlying as `0x${string}`,
      abi: MINT_ABI,
      functionName: "mint",
      args: [wallet.account as `0x${string}`, amount],
    });
    status.innerHTML = txDone(`Minted ${pair.underlyingSymbol}`, hash);
  } catch (error) {
    status.textContent = message(error);
  }
}

async function doWrap(pair: TokenPair): Promise<void> {
  const status = $("wrap-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    const amount = toBaseUnits(
      ($("wrap-amount") as HTMLInputElement).value,
      pair.decimals,
    );
    status.textContent = "Approving and wrapping…";
    const wrapped = await getWrapped(pair.confidentialToken);
    const result = await wrapped.shield(amount);
    status.innerHTML = `Wrapped into ${escapeHtml(pair.symbol)}${hashOf(result)}`;
  } catch (error) {
    status.textContent = message(error);
  }
}

async function doDecryptBalance(pair: TokenPair): Promise<void> {
  const status = $("bal-status");
  const out = $("bal-out");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    status.textContent = "Sign to decrypt your balance…";
    const wrapped = await getWrapped(pair.confidentialToken);
    const balance = (await wrapped.balanceOf(
      wallet.account as `0x${string}`,
    )) as bigint;
    out.textContent = `${fromBaseUnits(balance, pair.decimals)} ${pair.symbol}`;
    status.textContent = "Decrypted in your browser only.";
  } catch (error) {
    status.textContent = message(error);
  }
}

/* ------------------------------------------------------------------ */
/* Compose + seal view                                                */
/* ------------------------------------------------------------------ */

async function renderCompose(): Promise<void> {
  currentId = null;
  stopAuto();
  const view = $("view");
  view.innerHTML = `<div class="loading">Loading…</div>`;
  let pair: TokenPair;
  try {
    pair = await token();
  } catch (error) {
    view.innerHTML = errorHtml("Could not load tokens", error);
    return;
  }
  const soon = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16);
  view.innerHTML = `
    <a class="back" href="?" id="back">← all transfers</a>
    <h2 class="ph">Seal &amp; Configure Confidential Transfer</h2>
    <p class="muted wide">The instruction — who is paid, in which token, and a memo — is sealed into a
    Covenant with a price or time trigger. The <b>amount</b> stays out of the Covenant entirely; you send it
    confidentially with ${escapeHtml(pair.symbol)} when the transfer opens.</p>
    <div class="form">
      <label class="fl">Recipient
        <input id="c-recipient" class="in" placeholder="0x…" /></label>
      <label class="fl">Amount (${escapeHtml(pair.symbol)}) — kept in your browser
        <input id="c-amount" class="in" inputmode="decimal" placeholder="e.g. 100" /></label>
      <div class="frow">
        <label class="fl">Trigger asset
          <select id="c-asset" class="in">
            <option>ETH</option><option>BTC</option><option>SOL</option>
            <option>LINK</option><option>XRP</option><option>USDT</option>
          </select></label>
        <label class="fl">When
          <select id="c-op" class="in"><option value="&gt;=">rises to ≥</option><option value="&lt;=">falls to ≤</option></select></label>
        <label class="fl">Price (USD)
          <input id="c-target" class="in" inputmode="decimal" placeholder="e.g. 5000" /></label>
      </div>
      <div class="frow">
        <label class="fl">Deadline (expires if untriggered)
          <input id="c-deadline" class="in" type="datetime-local" value="${soon}" /></label>
        <label class="fl">Memo (optional, revealed on open)
          <input id="c-memo" class="in" maxlength="120" placeholder="rent, invoice #…" /></label>
      </div>
      <button class="btn solid big" id="seal-btn">Seal this transfer</button>
      <div class="status" id="seal-status"></div>
    </div>`;
  $("back").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  $("seal-btn").addEventListener("click", () => void doSeal(pair));
}

async function doSeal(pair: TokenPair): Promise<void> {
  const status = $("seal-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    const recipient = ($("c-recipient") as HTMLInputElement).value.trim();
    const amountHuman = ($("c-amount") as HTMLInputElement).value.trim();
    const asset = ($("c-asset") as HTMLSelectElement).value;
    const op = ($("c-op") as HTMLSelectElement).value;
    const targetUsd = ($("c-target") as HTMLInputElement).value.trim();
    const memo = ($("c-memo") as HTMLInputElement).value.trim();
    const deadlineLocal = ($("c-deadline") as HTMLInputElement).value;

    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      throw new Error("recipient must be a wallet address");
    }
    // Validate the amount now so a bad one is caught before sealing, even though
    // it is only sent at settlement.
    toBaseUnits(amountHuman, pair.decimals);
    const deadlineUnix = Math.floor(new Date(deadlineLocal).getTime() / 1000);
    if (!Number.isFinite(deadlineUnix)) {
      throw new Error("pick a deadline");
    }

    const cfg = await cachedConfig();
    const atomic = cfg.atomic && cfg.hook !== null && isAddress(cfg.hook);
    const escrowId = atomic ? randomId() : null;

    status.textContent = "Sealing the instruction and pricing the Covenant…";
    const built = await postJson<SealResponse>("/api/seal", {
      recipient,
      token: pair.confidentialToken,
      tokenSymbol: pair.symbol,
      memo: memo || undefined,
      asset,
      op,
      targetUsd,
      deadlineUnix,
      author: wallet.account,
      ...(atomic ? { useHook: true, amountCommitment: escrowId } : {}),
    });

    // Stash the amount (and, in atomic mode, the escrow id) locally. It never
    // leaves the browser; losing it only means re-entering the amount to settle,
    // or — for an atomic transfer that expires unrevealed — needing the id to refund.
    writeStash(built.commit, {
      amount: amountHuman,
      token: pair.confidentialToken,
      recipient,
      ...(escrowId ? { escrowId } : {}),
    });

    await ensureSepolia();

    // Atomic settlement: escrow the confidential amount into the hook now, so the
    // covenant's reveal can release it to the recipient in a single transaction.
    if (atomic && escrowId && cfg.hook) {
      const hook = cfg.hook as `0x${string}`;
      const amountUnits = toBaseUnits(amountHuman, pair.decimals);
      const walletClient = makeWalletClient();

      status.textContent =
        "Authorising the settlement hook to move your balance…";
      const until = Math.floor(Date.now() / 1000) + 86_400;
      const opHash = await walletClient.writeContract({
        address: pair.confidentialToken as `0x${string}`,
        abi: SET_OPERATOR_ABI,
        functionName: "setOperator",
        args: [hook, until],
      });
      await waitForReceipt(opHash);

      status.textContent =
        "Encrypting the amount for the hook and escrowing it…";
      const sdk = await getSdk();
      const enc = await sdk.encrypt({
        values: [{ value: amountUnits, type: "euint64" }],
        contractAddress: hook,
        userAddress: wallet.account as `0x${string}`,
      });
      const escrowHash = await walletClient.writeContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: "createSealedTransfer",
        args: [
          escrowId,
          pair.confidentialToken as `0x${string}`,
          recipient as `0x${string}`,
          enc.encryptedValues[0],
          enc.inputProof,
        ],
      });
      await waitForReceipt(escrowHash);
    }

    if (built.approve) {
      status.textContent = "Approve NIL for the protocol fee…";
      const approveHash = await sendTx(built.approve);
      // Wait for the approval to be mined so the post is estimated against the
      // updated allowance — otherwise the wallet rejects the post as failing.
      status.textContent = "Waiting for the NIL approval to confirm…";
      await waitForReceipt(approveHash);
    }
    if (
      built.simulated &&
      built.simulated !== "ok" &&
      !built.simulated.startsWith("not simulated")
    ) {
      if (
        !confirm(
          `Posting the Covenant is expected to revert:\n\n${built.simulated}\n\nSend anyway?`,
        )
      ) {
        status.textContent = "";
        return;
      }
    }
    status.textContent = "Post the Covenant to seal this transfer…";
    const hash = await sendTx(built.post);
    status.innerHTML = `${txDone("Sealed", hash)} — ${
      atomic
        ? "the amount is escrowed and auto-settles when the covenant opens."
        : "it will appear in the feed shortly."
    }`;
    window.setTimeout(() => go("?"), 3500);
  } catch (error) {
    status.textContent = message(error);
  }
}

/* ------------------------------------------------------------------ */
/* Settle + keeper actions                                            */
/* ------------------------------------------------------------------ */

async function doSettle(
  t: TransferDetail,
  instruction: { recipient: string; token: string; tokenSymbol: string | null },
): Promise<void> {
  const status = $("settle-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    const pair = await token();
    const decimals =
      instruction.token.toLowerCase() === pair.confidentialToken.toLowerCase()
        ? pair.decimals
        : 6;
    const amount = toBaseUnits(
      ($("settle-amount") as HTMLInputElement).value,
      decimals,
    );
    status.textContent = "Encrypting and sending confidentially…";
    const wrapped = await getWrapped(instruction.token);
    const result = await wrapped.confidentialTransfer(
      instruction.recipient as `0x${string}`,
      amount,
    );
    status.innerHTML = `Sent confidentially${hashOf(result)} — the amount stays encrypted on-chain.`;
    window.setTimeout(() => void loadTransfer(t.id, { silent: true }), 4000);
  } catch (error) {
    status.textContent = message(error);
  }
}

async function keeperAction(action: KeeperAction, id: string): Promise<void> {
  const status = $("keeper-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    status.textContent = "Building the transaction…";
    const result = await postJson<KeeperTxResponse>("/api/keeper-tx", {
      action,
      id,
    });
    if (result.simulated && result.simulated !== "ok") {
      if (
        !confirm(
          `This transaction is expected to revert:\n\n${result.simulated}\n\nSend anyway?`,
        )
      ) {
        status.textContent = "";
        return;
      }
    }
    const hash = await sendTx(result.tx);
    status.innerHTML = `${txDone(action, hash)}`;
    window.setTimeout(() => void loadTransfer(id, { silent: true }), 4000);
  } catch (error) {
    status.textContent = message(error);
  }
}

/* ------------------------------------------------------------------ */
/* Wallet (EIP-6963: MetaMask, Rainbow, …)                            */
/* ------------------------------------------------------------------ */

const wallet: {
  provider: Eip1193Provider | null;
  account: string | null;
  name: string;
  providers: Eip6963ProviderDetail[];
} = { provider: null, account: null, name: "", providers: [] };

window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = event.detail;
  if (!wallet.providers.find((entry) => entry.info.uuid === detail.info.uuid)) {
    wallet.providers.push(detail);
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function ensureWallet(): boolean {
  if (wallet.provider && wallet.account) {
    return true;
  }
  openWalletModal();
  return false;
}

function openWalletModal(): void {
  const list = $("wallet-list");
  if (wallet.providers.length) {
    list.innerHTML = wallet.providers
      .map(
        (entry) =>
          `<div class="wopt" data-uuid="${escapeHtml(entry.info.uuid)}"><img src="${escapeHtml(entry.info.icon)}" alt=""/><span class="wn">${escapeHtml(entry.info.name)}</span></div>`,
      )
      .join("");
  } else if (window.ethereum) {
    list.innerHTML = `<div class="wopt" data-injected="1"><span class="wn">Injected wallet</span></div>`;
  } else {
    list.innerHTML = `<div class="wnone">No wallet detected. Install MetaMask or Rainbow, then reload. Browsing the feed needs no wallet — only funding, sealing, settling, and keeper actions do.</div>`;
  }
  for (const option of list.querySelectorAll<HTMLElement>(".wopt[data-uuid]")) {
    option.addEventListener("click", () => {
      const entry = wallet.providers.find(
        (candidate) => candidate.info.uuid === option.getAttribute("data-uuid"),
      );
      if (entry) {
        void connectWith(entry.provider, entry.info.name);
      }
    });
  }
  const injected = list.querySelector<HTMLElement>(".wopt[data-injected]");
  if (injected && window.ethereum) {
    injected.addEventListener("click", () =>
      window.ethereum
        ? void connectWith(window.ethereum, "Injected")
        : undefined,
    );
  }
  $("wallet-modal").classList.add("open");
}

function closeWalletModal(): void {
  $("wallet-modal").classList.remove("open");
}

async function connectWith(
  provider: Eip1193Provider,
  name: string,
): Promise<void> {
  try {
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    wallet.provider = provider;
    wallet.account = accounts[0] ?? null;
    wallet.name = name;
    closeWalletModal();
    paintConnect();
    provider.on?.("accountsChanged", (...args: unknown[]) => {
      const next = (args[0] as string[] | undefined) ?? [];
      wallet.account = next[0] ?? null;
      if (!next[0]) {
        wallet.provider = null;
      }
      paintConnect();
    });
  } catch (error) {
    alert(`Could not connect: ${(error as Error).message}`);
  }
}

function paintConnect(): void {
  const button = $("connect-btn");
  if (wallet.account) {
    button.textContent = `${wallet.name} · ${truncateAddress(wallet.account)}`;
    button.classList.remove("ghost");
    button.classList.add("solid");
  } else {
    button.textContent = "Connect wallet";
    button.classList.add("ghost");
    button.classList.remove("solid");
  }
}

async function ensureSepolia(): Promise<void> {
  if (!wallet.provider) {
    return;
  }
  const chainId = await wallet.provider.request({ method: "eth_chainId" });
  if (chainId === SEPOLIA_HEX) {
    return;
  }
  try {
    await wallet.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (error) {
    if ((error as { code?: number }).code === 4902) {
      await wallet.provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: SEPOLIA_HEX,
            chainName: "Sepolia",
            nativeCurrency: {
              name: "Sepolia Ether",
              symbol: "ETH",
              decimals: 18,
            },
            rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    } else {
      throw error;
    }
  }
}

/** Send one prebuilt transaction with the connected wallet, returning its hash. */
async function sendTx(tx: Tx): Promise<string> {
  await ensureSepolia();
  return (await wallet.provider?.request({
    method: "eth_sendTransaction",
    params: [
      { from: wallet.account, to: tx.to, data: tx.data, value: tx.value },
    ],
  })) as string;
}

/* ------------------------------------------------------------------ */
/* Local amount stash (never leaves the browser)                      */
/* ------------------------------------------------------------------ */

interface Stash {
  amount: string;
  token: string;
  recipient: string;
  /** For atomic transfers, the escrow id — kept locally so the sender can
   *  refund even if the covenant expires without ever revealing it. */
  escrowId?: string;
}

function writeStash(commit: string, stash: Stash): void {
  try {
    localStorage.setItem(
      `zilch:amt:${commit.toLowerCase()}`,
      JSON.stringify(stash),
    );
  } catch {
    // Private-mode or disabled storage: settlement just asks for the amount again.
  }
}

function readStash(commit: string): Stash | null {
  try {
    const raw = localStorage.getItem(`zilch:amt:${commit.toLowerCase()}`);
    return raw ? (JSON.parse(raw) as Stash) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Small view helpers                                                 */
/* ------------------------------------------------------------------ */

function txDone(label: string, hash: string): string {
  return `${escapeHtml(label)} · <a class="mono" href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">${truncateAddress(hash)}</a>`;
}

/** Render a tx-hash link from an SDK return value, tolerating a hash string, a
 *  `{ hash }`/`{ transactionHash }` object, or nothing. */
function hashOf(result: unknown): string {
  const record = result as { hash?: string; transactionHash?: string } | null;
  const hash =
    typeof result === "string"
      ? result
      : (record?.hash ?? record?.transactionHash);
  return hash
    ? ` · <a class="mono" href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">${truncateAddress(hash)}</a>`
    : "";
}

function message(error: unknown): string {
  return (
    (error as { shortMessage?: string }).shortMessage ??
    (error as Error).message ??
    String(error)
  );
}

function errorHtml(title: string, error: unknown): string {
  return `<div class="errbox"><b>${escapeHtml(title)}</b><p class="mono tiny">${escapeHtml(message(error))}</p>
    <p class="muted">If this is a fresh deployment, the on-chain reads may not be reachable yet.</p></div>`;
}

function updateStamp(): void {
  const stamp = document.getElementById("stamp");
  if (stamp) {
    stamp.textContent = `updated ${new Date().toLocaleTimeString()}`;
  }
}

/* ------------------------------------------------------------------ */
/* Deploy dashboard (settlement hook)                                 */
/* ------------------------------------------------------------------ */

let deployedHook: string | null = null;

async function renderDeploy(): Promise<void> {
  currentId = null;
  stopAuto();
  const view = $("view");
  view.innerHTML = `<div class="loading">Loading configuration…</div>`;
  let cfg: ConfigResponse | null = null;
  let cfgError = "";
  try {
    cfg = await getConfig();
  } catch (error) {
    cfgError = message(error);
  }
  const market = cfg?.market ?? "";
  const existing = cfg?.hook ?? "";
  view.innerHTML = `
    <a class="back" href="?" id="back">← all transfers</a>
    <h2 class="ph">Deploy the Settlement Hook</h2>
    <p class="muted wide">This optional contract makes settlement <b>atomic</b>. The confidential amount is
    escrowed when a transfer is sealed and released to the sealed recipient <i>inside the Covenant's reveal
    transaction</i> — so the payment happens if and only if the Covenant opens, for the escrowed (still
    encrypted) amount, to the sealed recipient. Without it, revealing only surfaces the instruction and the
    transfer is a separate manual step bound to the reveal by nothing but app logic.</p>
    <div class="errbox" style="margin:0 0 1.25rem">
      <b>Unaudited, untested reference contract.</b>
      <p class="muted">Deploying here is safe — a deployment succeeds whenever the contract compiles — but its
      on-chain behaviour has not been validated. Deploy to <b>Sepolia</b>, exercise escrow → reveal → release
      and the refund path on testnet, and review the source before any real use. Design and caveats:
      <span class="mono">contracts/README.md</span>.</p>
    </div>
    <div class="grid3">
      <div class="ipanel">
        <div class="step">1</div><div class="ilabel">Deploy</div>
        <p class="muted">Deploy <span class="mono">ZilchSettlementHook</span> with the Blacklight market as its
        constructor argument.</p>
        <label class="tiny muted">TriggerMarket (constructor arg)</label>
        <input id="dep-market" class="in mono" placeholder="0x…" value="${escapeHtml(market)}" />
        <button class="btn solid" id="dep-btn">Deploy settlement hook</button>
        <div class="status" id="dep-status">${
          cfgError
            ? escapeHtml(
                `Could not resolve the market (${cfgError}). Paste it manually.`,
              )
            : ""
        }</div>
      </div>
      <div class="ipanel">
        <div class="step">2</div><div class="ilabel">Validate</div>
        <p class="muted">Confirm an address is a deployed contract on this chain before you trust it.</p>
        <label class="tiny muted">Hook address</label>
        <input id="val-addr" class="in mono" placeholder="0x…" value="${escapeHtml(existing)}" />
        <button class="btn ghost" id="val-btn">Check on-chain</button>
        <div class="status" id="val-status"></div>
      </div>
      <div class="ipanel">
        <div class="step">3</div><div class="ilabel">Configure</div>
        <p class="muted">Set this in your environment, then redeploy the app to enable atomic mode.</p>
        <div class="status" id="cfg-out">${
          existing
            ? `Currently configured: <span class="mono">${escapeHtml(existing)}</span>`
            : "No hook configured yet."
        }</div>
        <button class="btn ghost" id="cfg-btn">Generate config</button>
        <div class="status" id="cfg-gen"></div>
      </div>
    </div>
    <p class="muted wide tiny">Chain id <span class="mono">${cfg?.chainId ?? "?"}</span>. Atomic settlement is
    currently <b>${cfg?.atomic ? "enabled" : "disabled"}</b>. After configuring the hook, wiring the client-side
    escrow and auto-settle flow is the final step (see the README); enable it once the deployed contract is
    validated on-chain.</p>`;
  $("back").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  $("dep-btn").addEventListener("click", () => void doDeployHook());
  $("val-btn").addEventListener("click", () => void doValidateHook());
  $("cfg-btn").addEventListener("click", doGenerateConfig);
}

async function doDeployHook(): Promise<void> {
  const status = $("dep-status");
  try {
    if (!ensureWallet()) {
      return;
    }
    await ensureSepolia();
    const market = ($("dep-market") as HTMLInputElement).value.trim();
    if (!isAddress(market)) {
      status.textContent = "Enter a valid market address.";
      return;
    }
    status.textContent = "Confirm the deployment in your wallet…";
    const walletClient = makeWalletClient();
    const hash = await walletClient.deployContract({
      abi: HOOK_ABI,
      bytecode: HOOK_BYTECODE,
      args: [market as `0x${string}`],
    });
    status.innerHTML = `${txDone("Deployment sent", hash)} — waiting for the receipt…`;
    const receipt = await waitForReceipt(hash);
    const addr = receipt.contractAddress;
    if (!addr) {
      status.textContent =
        "Deployed, but the receipt carried no contract address.";
      return;
    }
    deployedHook = addr;
    ($("val-addr") as HTMLInputElement).value = addr;
    status.innerHTML = `Deployed at <span class="mono">${escapeHtml(addr)}</span>. Validate it, then generate the config.`;
  } catch (error) {
    status.textContent = message(error);
  }
}

async function doValidateHook(): Promise<void> {
  const status = $("val-status");
  try {
    const addr = ($("val-addr") as HTMLInputElement).value.trim();
    if (!isAddress(addr)) {
      status.textContent = "Enter a valid address.";
      return;
    }
    status.textContent = "Checking…";
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(),
    });
    const code = await publicClient.getCode({ address: addr as `0x${string}` });
    if (code && code !== "0x") {
      deployedHook = addr;
      status.innerHTML = `✓ Contract found (${Math.floor((code.length - 2) / 2)} bytes of runtime bytecode).`;
    } else {
      status.textContent = "No contract code at that address on this chain.";
    }
  } catch (error) {
    status.textContent = message(error);
  }
}

function doGenerateConfig(): void {
  const gen = $("cfg-gen");
  const addr = (
    deployedHook ?? ($("val-addr") as HTMLInputElement).value
  ).trim();
  if (!isAddress(addr)) {
    gen.textContent = "Deploy or validate a hook address first.";
    return;
  }
  const env = `ZILCH_HOOK=${addr}\n# Optional: gas budget for the reveal-time hook call (default 3000000)\n# ZILCH_HOOK_GAS=3000000\n`;
  const url = URL.createObjectURL(new Blob([env], { type: "text/plain" }));
  gen.innerHTML = `
    <p class="muted tiny">Add to <span class="mono">.env.local</span> for local dev, or set as a project
    environment variable in Vercel (Settings → Environment Variables), then redeploy.</p>
    <pre class="mono" style="white-space:pre-wrap;word-break:break-all;padding:.6rem .7rem;border-radius:8px;font-size:.8rem">${escapeHtml(env)}</pre>
    <a class="btn ghost" href="${url}" download=".env.local">Download .env.local</a>`;
}

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

function go(search: string): void {
  history.pushState({}, "", search || location.pathname);
  void route();
}

async function route(): Promise<void> {
  const params = new URL(location.href).searchParams;
  const id = params.get("id");
  const view = params.get("view");
  paintConnect();
  if (id) {
    await loadTransfer(id);
  } else if (view === "fund") {
    await renderFund();
  } else if (view === "compose") {
    await renderCompose();
  } else if (view === "deploy") {
    await renderDeploy();
  } else {
    await loadFeed();
  }
}

/* ------------------------------------------------------------------ */
/* Auto-refresh                                                       */
/* ------------------------------------------------------------------ */

let pollTimer: number | null = null;
let tickTimer: number | null = null;

function stopAuto(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startFeedAuto(): void {
  stopAuto();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && currentId === null) {
      void loadFeed({ silent: true });
    }
  }, REFRESH_MS);
  tickTimer = window.setInterval(() => {
    updateStamp();
    tickFuses();
  }, 1000);
}

function startTransferAuto(id: string): void {
  stopAuto();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && currentId === id) {
      void loadTransfer(id, { silent: true });
    }
  }, REFRESH_MS);
  tickTimer = window.setInterval(tickFuses, 1000);
}

function tickFuses(): void {
  const now = chainNow();
  for (const line of document.querySelectorAll<HTMLElement>(
    ".fuseline.sealed",
  )) {
    const deadline = Number(line.getAttribute("data-deadline"));
    if (deadline) {
      line.textContent = countdown(deadline, now);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function init(): void {
  $("connect-btn").addEventListener("click", openWalletModal);
  $("brand").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  $("nav-feed").addEventListener("click", (event) => {
    event.preventDefault();
    go("?");
  });
  $("nav-fund").addEventListener("click", (event) => {
    event.preventDefault();
    go("?view=fund");
  });
  $("nav-new").addEventListener("click", (event) => {
    event.preventDefault();
    go("?view=compose");
  });
  const deployLink = document.getElementById("nav-deploy");
  if (deployLink) {
    deployLink.addEventListener("click", (event) => {
      event.preventDefault();
      go("?view=deploy");
    });
  }
  const closer = document.getElementById("wallet-close");
  if (closer) {
    closer.addEventListener("click", closeWalletModal);
  }
  // Delegated buttons that appear inside rendered views.
  document.body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "new-2") {
      go("?view=compose");
    } else if (target.id === "fund-2") {
      go("?view=fund");
    }
  });
  window.addEventListener("popstate", () => void route());
  void route();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
