/**
 * zilch — the browser client.
 *
 * A single-page app over the sealed-transfer feed and one transfer's detail
 * (both wallet-free reads), plus the flows that touch a wallet: funding a
 * confidential balance, sealing a transfer into a Covenant, and settling one
 * once it opens. Reads talk only to the `/api` routes, which return preformatted
 * JSON — the client ships no ABIs. The amount is the client's alone: it is
 * encrypted here with Zama's SDK (loaded from a CDN, never bundled) and handed to
 * the wallet as a ciphertext handle, so it is never seen by the server or the
 * chain. The wallet is discovered via EIP-6963, so MetaMask, Rainbow, and any
 * other conforming wallet all work.
 */

import {
  escapeHtml,
  formatDateUtc,
  formatDuration,
  relativeTime,
  truncateAddress,
} from "../core/format.js";
import type {
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

/* ------------------------------------------------------------------ */
/* Constants and small helpers                                        */
/* ------------------------------------------------------------------ */

const SEPOLIA_HEX = "0xaa36a7"; // 11155111
const EXPLORER = "https://sepolia.etherscan.io";
const REFRESH_MS = 12000; // Sepolia's ~12s block time
const PERMIT_DAYS = 7; // how long a decryption permit stays valid

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
/* Zama (loaded from a CDN as window.relayerSDK)                      */
/* ------------------------------------------------------------------ */

let zamaInstance: ZamaInstance | null = null;
let zamaInit: Promise<ZamaInstance> | null = null;

/** Lazily initialise the Zama SDK and build a Sepolia instance, once. */
async function getZama(): Promise<ZamaInstance> {
  if (zamaInstance) {
    return zamaInstance;
  }
  const sdk = window.relayerSDK;
  if (!sdk) {
    throw new Error(
      "Zama SDK failed to load — check the CDN <script> in index.html",
    );
  }
  if (!zamaInit) {
    zamaInit = (async () => {
      await sdk.initSDK();
      const instance = await sdk.createInstance(sdk.SepoliaConfig);
      zamaInstance = instance;
      return instance;
    })();
  }
  return zamaInit;
}

/** Normalise a handle or proof (bytes or hex) to `0x`-hex. */
function toHex(value: Uint8Array | string): string {
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  let hex = "0x";
  for (const byte of value) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Encrypt an amount for one token and the connected account, returning the
 *  external handle and input proof the confidential transfer needs. */
async function encryptAmount(
  token: string,
  amount: bigint,
): Promise<{ handle: string; inputProof: string }> {
  if (!wallet.account) {
    throw new Error("connect a wallet first");
  }
  const instance = await getZama();
  const input = instance.createEncryptedInput(token, wallet.account);
  input.add64(amount);
  const enc = await input.encrypt();
  return { handle: toHex(enc.handles[0]), inputProof: toHex(enc.inputProof) };
}

/** User-decrypt a single balance handle for one token, via an EIP-712 permit the
 *  wallet signs. Returns the cleartext as a decimal string. */
async function userDecrypt(token: string, handle: string): Promise<string> {
  if (!wallet.account || !wallet.provider) {
    throw new Error("connect a wallet first");
  }
  const instance = await getZama();
  const { publicKey, privateKey } = instance.generateKeypair();
  const start = Math.floor(Date.now() / 1000);
  const contracts = [token];
  const eip712 = instance.createEIP712(
    publicKey,
    contracts,
    start,
    PERMIT_DAYS,
  );
  const signature = (await wallet.provider.request({
    method: "eth_signTypedData_v4",
    params: [wallet.account, JSON.stringify(eip712)],
  })) as string;
  const result = await instance.userDecrypt(
    [{ handle, contractAddress: token }],
    privateKey,
    publicKey,
    signature.replace(/^0x/, ""),
    contracts,
    wallet.account,
    start,
    PERMIT_DAYS,
  );
  return String(result[handle] ?? "");
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

  const settle = t.outcome === "open" && t.instruction ? settlePanel(t) : "";

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

function committeeHtml(t: TransferDetail): string {
  if (!t.committee.length) {
    return `<p class="muted">No committee slots recorded.</p>`;
  }
  return `<div class="slots">${t.committee
    .map(
      (slot) =>
        `<div class="slot ${slot.shared ? "on" : ""}"><span class="mono">#${slot.slot}</span>
        <span class="mono tiny">${slot.nodeId ? `node ${escapeHtml(slot.nodeId)}` : "key " + escapeHtml(truncateAddress(slot.keyId))}</span>
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
    const amount = toBaseUnits(
      ($("faucet-amount") as HTMLInputElement).value,
      pair.decimals,
    );
    status.textContent = "Building mint…";
    const tx = await postJson<Tx>("/api/tx", {
      kind: "faucet",
      token: pair.confidentialToken,
      amount: amount.toString(),
      from: wallet.account,
    });
    const hash = await sendTx(tx);
    status.innerHTML = txDone("Minted", hash);
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
    const amount = toBaseUnits(
      ($("wrap-amount") as HTMLInputElement).value,
      pair.decimals,
    );
    status.textContent = "Approving the wrapper…";
    const approve = await postJson<Tx>("/api/tx", {
      kind: "approve",
      token: pair.confidentialToken,
      amount: amount.toString(),
      from: wallet.account,
    });
    await sendTx(approve);
    status.textContent = "Approved. Wrapping…";
    const wrap = await postJson<Tx>("/api/tx", {
      kind: "wrap",
      token: pair.confidentialToken,
      amount: amount.toString(),
      from: wallet.account,
    });
    const hash = await sendTx(wrap);
    status.innerHTML = txDone(`Wrapped into ${escapeHtml(pair.symbol)}`, hash);
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
    status.textContent = "Reading the handle…";
    const { handle } = await getJson<{ handle: string }>(
      `/api/balance?token=${pair.confidentialToken}&account=${wallet.account}`,
    );
    status.textContent = "Sign the permit to decrypt…";
    const clear = await userDecrypt(pair.confidentialToken, handle);
    out.textContent = `${fromBaseUnits(clear, pair.decimals)} ${pair.symbol}`;
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
    });

    // Stash the amount locally so settlement can prefill it. It never leaves the
    // browser; losing it only means re-entering the amount to settle.
    writeStash(built.commit, {
      amount: amountHuman,
      token: pair.confidentialToken,
      recipient,
    });

    await ensureSepolia();
    if (built.approve) {
      status.textContent = "Approve NIL for the protocol fee…";
      await sendTx(built.approve);
    }
    status.textContent = "Post the Covenant to seal this transfer…";
    const hash = await sendTx(built.post);
    status.innerHTML = `${txDone("Sealed", hash)} — it will appear in the feed shortly.`;
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
    const pair = await token();
    const decimals =
      instruction.token.toLowerCase() === pair.confidentialToken.toLowerCase()
        ? pair.decimals
        : 6;
    const amount = toBaseUnits(
      ($("settle-amount") as HTMLInputElement).value,
      decimals,
    );
    status.textContent = "Encrypting the amount in your browser…";
    const { handle, inputProof } = await encryptAmount(
      instruction.token,
      amount,
    );
    status.textContent = "Building the confidential transfer…";
    const tx = await postJson<Tx>("/api/tx", {
      kind: "send",
      token: instruction.token,
      recipient: instruction.recipient,
      handle,
      inputProof,
      from: wallet.account,
    });
    const hash = await sendTx(tx);
    status.innerHTML = `${txDone("Sent confidentially", hash)} — the amount stays encrypted on-chain.`;
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
