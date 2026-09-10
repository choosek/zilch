/**
 * Unit tests for the pure presentation helpers.
 *
 * Each helper is a deterministic transformation of its inputs, so these assert
 * the branches directly: HTML escaping of every significant character, address
 * abbreviation across the short/long/absent cases, exact-decimal USD grouping,
 * the coarse duration units, relative time on both sides of the reference clock,
 * the UTC stamp, and the mode label.
 */

import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  formatDateUtc,
  formatDuration,
  formatUsd,
  modeLabel,
  relativeTime,
  truncateAddress,
} from "#/core/format";

describe("escapeHtml", () => {
  test("escapes all five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
  test("renders null and undefined as the empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("truncateAddress", () => {
  test("abbreviates a full address to head and tail", () => {
    expect(truncateAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234…5678",
    );
  });
  test("returns an em dash for a missing address", () => {
    expect(truncateAddress(null)).toBe("—");
    expect(truncateAddress(undefined)).toBe("—");
    expect(truncateAddress("")).toBe("—");
  });
  test("returns short values unchanged", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234");
  });
});

describe("formatUsd", () => {
  test("groups thousands and keeps up to two decimals", () => {
    expect(formatUsd("100000")).toBe("$100,000");
    expect(formatUsd("1234567.891")).toBe("$1,234,567.89");
    expect(formatUsd("0.5")).toBe("$0.5");
  });
  test("returns an em dash for a missing value", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });
});

describe("formatDuration", () => {
  test("chooses a coarse unit by magnitude", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(172800)).toBe("2d");
  });
  test("uses magnitude for negative durations", () => {
    expect(formatDuration(-45)).toBe("45s");
  });
  test("returns an em dash for a missing value", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("relativeTime", () => {
  test("renders future and past against the reference clock", () => {
    expect(relativeTime(1000 + 600, 1000)).toBe("in 10m");
    expect(relativeTime(1000 - 600, 1000)).toBe("10m ago");
  });
  test("returns an em dash for a missing timestamp", () => {
    expect(relativeTime(0, 1000)).toBe("—");
    expect(relativeTime(null, 1000)).toBe("—");
  });
});

describe("formatDateUtc", () => {
  test("renders a minute-resolution UTC stamp", () => {
    expect(formatDateUtc(1893456000)).toBe("2030-01-01 00:00Z");
  });
  test("returns an em dash for a missing timestamp", () => {
    expect(formatDateUtc(0)).toBe("—");
    expect(formatDateUtc(null)).toBe("—");
  });
});

describe("modeLabel", () => {
  test("labels the two modes and nothing else", () => {
    expect(modeLabel(0)).toBe("Private");
    expect(modeLabel(1)).toBe("Public");
    expect(modeLabel(7)).toBe("");
  });
});
