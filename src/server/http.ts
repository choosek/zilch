/**
 * Small response helpers shared by every `/api` route.
 *
 * On-chain quantities are represented as `bigint` throughout the server, so
 * {@link send} serializes with a replacer that renders any `bigint` as a decimal
 * string — the wire convention the client expects. {@link fail} writes the
 * uniform error body, and {@link queryParam} reads a single query value from
 * Vercel's parsed request.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { ErrorResponse } from "../shared/types.js";

/** Serialize `body` as JSON with `bigint` rendered as a decimal string. */
export function send(res: VercelResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(
    JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

/** Write the uniform `{ error, detail? }` body with an HTTP status. */
export function fail(
  res: VercelResponse,
  status: number,
  error: string,
  detail?: unknown,
): void {
  const body: ErrorResponse = { error };
  if (detail !== undefined) {
    body.detail = String(detail).slice(0, 300);
  }
  send(res, body, status);
}

/** Read a single query-string value, collapsing the array form Vercel may hand
 *  back and returning `null` when the key is absent. */
export function queryParam(req: VercelRequest, key: string): string | null {
  const value = req.query?.[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
