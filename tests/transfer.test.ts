/**
 * Unit tests for sealed-transfer outcome derivation — the precedence of open
 * over the clock, expiry past the deadline, and sealed otherwise.
 */

import { describe, expect, test } from "vitest";
import { transferOutcome } from "#/core/transfer";

describe("transferOutcome", () => {
  test("a resolved covenant is open regardless of the clock", () => {
    expect(
      transferOutcome({ resolved: true, deadline: 1, nowUnix: 9999 }),
    ).toBe("open");
  });
  test("unresolved past the deadline is expired", () => {
    expect(
      transferOutcome({ resolved: false, deadline: 1000, nowUnix: 2000 }),
    ).toBe("expired");
  });
  test("unresolved before the deadline is sealed", () => {
    expect(
      transferOutcome({ resolved: false, deadline: 5000, nowUnix: 1000 }),
    ).toBe("sealed");
  });
  test("a null clock is sealed, never expired", () => {
    expect(
      transferOutcome({ resolved: false, deadline: 1000, nowUnix: null }),
    ).toBe("sealed");
  });
  test("a zero deadline is sealed", () => {
    expect(
      transferOutcome({ resolved: false, deadline: 0, nowUnix: 1000 }),
    ).toBe("sealed");
  });
});
