/**
 * Pure presentation helpers shared by the server (for the display strings it
 * sends alongside raw values) and the browser client (for everything it renders).
 *
 * Nothing here reaches the network, touches the DOM, or depends on the SDK: each
 * function is a deterministic transformation of its inputs, which is what lets the
 * same helpers run in a serverless function and in the browser bundle, and what
 * makes them exhaustively unit-testable. Numeric on-chain quantities are converted
 * to decimal strings by the SDK on the server; the helpers here only shape
 * already-decimal strings, unix seconds, and addresses for reading.
 */

/** Escape the five HTML-significant characters so a value read from the chain
 *  can be interpolated into markup without becoming markup. Applied to every
 *  dynamic string the client writes into the document. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] as string,
  );
}

/** Abbreviate a 20-byte address to `0x1234…cdef`, or an em dash when absent.
 *  Short values (a hex string of ten characters or fewer) are returned unchanged,
 *  since abbreviating them would only lose information. */
export function truncateAddress(address: string | null | undefined): string {
  if (!address) {
    return "—";
  }
  if (address.length <= 10) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Render an exact-decimal USD string with thousands separators and at most two
 *  fractional digits, prefixed with a dollar sign. The input is the decimal
 *  string the SDK produces from 10^-8 units, so no floating-point rounding is
 *  introduced here. */
export function formatUsd(decimal: string | null | undefined): string {
  if (decimal === null || decimal === undefined) {
    return "—";
  }
  const [whole, fraction] = String(decimal).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}${fraction ? `.${fraction.slice(0, 2)}` : ""}`;
}

/** Choose a coarse unit (seconds, minutes, hours, days) for a duration in
 *  seconds and render it compactly, e.g. `45s`, `12m`, `5h`, `2d`. Returns an em
 *  dash for `null`/`undefined`. Shared by both the relative-time and the
 *  fixed-duration renderers below. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "—";
  }
  const magnitude = Math.abs(seconds);
  if (magnitude < 90) {
    return `${Math.round(magnitude)}s`;
  }
  if (magnitude < 5400) {
    return `${Math.round(magnitude / 60)}m`;
  }
  if (magnitude < 129600) {
    return `${Math.round(magnitude / 3600)}h`;
  }
  return `${Math.round(magnitude / 86400)}d`;
}

/** Render a unix time relative to a reference clock as `in 3m` or `5h ago`. The
 *  reference must be chain time (the latest block's timestamp), never the wall
 *  clock, so that "expires in" and "opened ago" agree with what the contract
 *  measures against. Returns an em dash for a missing or zero timestamp. */
export function relativeTime(
  unix: number | null | undefined,
  nowUnix: number,
): string {
  if (!unix) {
    return "—";
  }
  const delta = unix - nowUnix;
  const rendered = formatDuration(delta);
  return delta >= 0 ? `in ${rendered}` : `${rendered} ago`;
}

/** Render a unix time as a minute-resolution UTC stamp, `YYYY-MM-DD HH:MMZ`, for
 *  the fixed points a covenant's window is expressed in. Returns an em dash for a
 *  missing or zero timestamp. */
export function formatDateUtc(unix: number | null | undefined): string {
  if (!unix) {
    return "—";
  }
  return `${new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16)}Z`;
}

/** The human label for a covenant's sealing mode: `0` is Private (the price
 *  threshold is sealed to the committee), `1` is Public. Any other value yields
 *  the empty string rather than a misleading label. */
export function modeLabel(mode: number): string {
  if (mode === 0) {
    return "Private";
  }
  if (mode === 1) {
    return "Public";
  }
  return "";
}
