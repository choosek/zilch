/**
 * Unit tests for the instruction codec.
 *
 * These check the round-trip with and without an amount commitment and a memo,
 * unicode memos, address round-tripping, rejection of a malformed address, and
 * the null results for a non-zilch payload, a too-short payload, and a payload
 * whose commitment flag is set but whose bytes are truncated.
 */

import { describe, expect, test } from "vitest";
import {
  addressToBytes,
  decodeInstruction,
  encodeInstruction,
} from "#/core/instruction";

const alice = "0x00000000000000000000000000000000000000a1";
const token = "0x00000000000000000000000000000000000000b2";
const commit = `0x${"cd".repeat(32)}`;

describe("encodeInstruction / decodeInstruction", () => {
  test("round-trips recipient, token, commitment, and memo", () => {
    const bytes = encodeInstruction({
      recipient: alice,
      token,
      amountCommitment: commit,
      memo: "rent for June",
    });
    expect(decodeInstruction(bytes)).toEqual({
      recipient: alice,
      token,
      tokenSymbol: null,
      memo: "rent for June",
      amountCommitment: commit,
    });
  });

  test("round-trips without a commitment or memo", () => {
    const bytes = encodeInstruction({ recipient: alice, token });
    expect(decodeInstruction(bytes)).toEqual({
      recipient: alice,
      token,
      tokenSymbol: null,
      memo: null,
      amountCommitment: null,
    });
  });

  test("a unicode memo survives", () => {
    const bytes = encodeInstruction({
      recipient: alice,
      token,
      memo: "café ▲",
    });
    expect(decodeInstruction(bytes)?.memo).toBe("café ▲");
  });

  test("a non-zilch payload decodes to null", () => {
    expect(
      decodeInstruction(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    ).toBeNull();
  });

  test("a payload too short to hold the head is null", () => {
    const short = new TextEncoder().encode("ZILCH1");
    expect(decodeInstruction(short)).toBeNull();
  });

  test("a long payload with the wrong magic is null", () => {
    // long enough to pass the head-length guard, but not a zilch payload
    const wrong = new Uint8Array(60);
    wrong[0] = "X".charCodeAt(0);
    expect(decodeInstruction(wrong)).toBeNull();
  });

  test("a truncated committed payload is null", () => {
    const full = encodeInstruction({
      recipient: alice,
      token,
      amountCommitment: commit,
    });
    // keep the head (magic+flags+two addresses) but drop the commitment bytes
    const head = full.slice(0, 6 + 1 + 20 + 20);
    expect(decodeInstruction(head)).toBeNull();
  });
});

describe("addressToBytes", () => {
  test("accepts 20-byte hex with or without 0x", () => {
    expect(addressToBytes(alice)).toHaveLength(20);
    expect(addressToBytes(alice.slice(2))).toHaveLength(20);
  });
  test("rejects a wrong-length address", () => {
    expect(() => addressToBytes("0x1234")).toThrow();
  });
});
