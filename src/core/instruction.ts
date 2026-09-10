/**
 * The instruction codec — what a sealed transfer commits to, and how it reads
 * when the covenant opens.
 *
 * A sealed transfer's covenant carries an *instruction* in its sealed payload:
 * the recipient, the confidential token, an optional amount commitment, and a
 * memo. It is framed with a magic header so that when a covenant opens, a zilch
 * instruction can be told apart from any other payload and rendered, while a
 * non-zilch payload is reported as such rather than mis-parsed. The framing is
 * fixed-width where it can be and length-free otherwise, so the round-trip is a
 * pure function tested directly. Deliberately absent: the amount — it never
 * touches the covenant, only Zama's ciphertext.
 *
 * Layout: "ZILCH1" (6) ‖ flags (1) ‖ recipient (20) ‖ token (20) ‖
 *         [commitment (32) iff flags bit 0] ‖ memo (utf-8, remainder).
 */

import type { Instruction } from "../shared/types.js";

const MAGIC = "ZILCH1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const ADDR_BYTES = 20;
const COMMIT_BYTES = 32;
const FLAG_HAS_COMMITMENT = 0x01;
const HEAD = MAGIC_BYTES.length + 1 + ADDR_BYTES + ADDR_BYTES;

/** Encode an instruction into the covenant's sealed payload bytes. */
export function encodeInstruction(input: {
  recipient: string;
  token: string;
  amountCommitment?: string | null;
  memo?: string | null;
}): Uint8Array {
  const recipient = addressToBytes(input.recipient);
  const token = addressToBytes(input.token);
  const commitment =
    input.amountCommitment != null && input.amountCommitment.length > 0
      ? fixedHexToBytes(input.amountCommitment, COMMIT_BYTES)
      : null;
  const memo = new TextEncoder().encode(input.memo ?? "");

  const size = HEAD + (commitment ? COMMIT_BYTES : 0) + memo.length;
  const out = new Uint8Array(size);
  out.set(MAGIC_BYTES, 0);
  out[MAGIC_BYTES.length] = commitment ? FLAG_HAS_COMMITMENT : 0;
  let offset = MAGIC_BYTES.length + 1;
  out.set(recipient, offset);
  offset += ADDR_BYTES;
  out.set(token, offset);
  offset += ADDR_BYTES;
  if (commitment) {
    out.set(commitment, offset);
    offset += COMMIT_BYTES;
  }
  out.set(memo, offset);
  return out;
}

/**
 * Decode a revealed payload into an instruction, or `null` when the payload is
 * not a zilch instruction (some other covenant's payload) or is too short to be
 * one. `tokenSymbol` is left null — the caller resolves it from the token
 * registry, which is the source of truth for symbols.
 */
export function decodeInstruction(payload: Uint8Array): Instruction | null {
  if (payload.length < HEAD || !startsWithMagic(payload)) {
    return null;
  }
  const flags = payload[MAGIC_BYTES.length];
  const hasCommitment = (flags & FLAG_HAS_COMMITMENT) !== 0;
  if (hasCommitment && payload.length < HEAD + COMMIT_BYTES) {
    return null;
  }

  let offset = MAGIC_BYTES.length + 1;
  const recipient = bytesToAddress(payload.slice(offset, offset + ADDR_BYTES));
  offset += ADDR_BYTES;
  const token = bytesToAddress(payload.slice(offset, offset + ADDR_BYTES));
  offset += ADDR_BYTES;

  let amountCommitment: string | null = null;
  if (hasCommitment) {
    amountCommitment = bytesToHex(payload.slice(offset, offset + COMMIT_BYTES));
    offset += COMMIT_BYTES;
  }
  const memoBytes = payload.slice(offset);
  const memo = memoBytes.length ? new TextDecoder().decode(memoBytes) : null;

  return { recipient, token, tokenSymbol: null, memo, amountCommitment };
}

/* ---- byte helpers (pure) ---- */

function startsWithMagic(payload: Uint8Array): boolean {
  for (let index = 0; index < MAGIC_BYTES.length; index++) {
    if (payload[index] !== MAGIC_BYTES[index]) {
      return false;
    }
  }
  return true;
}

/** Parse a `0x`-prefixed 20-byte address to bytes, tolerating no prefix. Throws
 *  on a wrong length so a malformed instruction never encodes silently. */
export function addressToBytes(address: string): Uint8Array {
  return fixedHexToBytes(address, ADDR_BYTES);
}

function fixedHexToBytes(hex: string, length: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== length * 2) {
    throw new Error(`expected ${length} bytes of hex, got ${clean.length / 2}`);
  }
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function bytesToAddress(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/** Lower-case `0x`-hex. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
