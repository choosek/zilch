/**
 * Unit tests for release-condition shaping.
 *
 * These cover the comparator mapping and every combination the shaper decides
 * between: a public record with a price clause, a record whose window overrides
 * the meta window, a record with no price clause, a Private covenant reporting a
 * sealed threshold, and a public covenant with only a meta window.
 */

import { describe, expect, test } from "vitest";
import {
  COMPARATOR_GTE,
  COMPARATOR_LTE,
  COMPARATOR_NONE,
  comparatorOp,
  type DecodedRecord,
  describeCondition,
  opSymbol,
  triggerText,
} from "#/core/condition";

const priceRecord: DecodedRecord = {
  assetName: "BTC",
  comparator: COMPARATOR_GTE,
  threshold1e8: "10000000000000",
  thresholdUsd: "100000",
  t1: 0,
  t2: 0,
  hex: "0xabcd",
};

describe("comparatorOp", () => {
  test("maps the two comparators and rejects the rest", () => {
    expect(comparatorOp(COMPARATOR_GTE)).toBe(">=");
    expect(comparatorOp(COMPARATOR_LTE)).toBe("<=");
    expect(comparatorOp(COMPARATOR_NONE)).toBeNull();
    expect(comparatorOp(42)).toBeNull();
  });
});

describe("describeCondition", () => {
  test("a public price record yields a price clause and the raw hex", () => {
    const condition = describeCondition({
      mode: 1,
      metaT1: 0,
      metaT2: 0,
      record: priceRecord,
    });
    expect(condition.price).toEqual({
      asset: "BTC",
      op: ">=",
      threshold1e8: "10000000000000",
      thresholdUsd: "100000",
    });
    expect(condition.window).toBeNull();
    expect(condition.sealed).toBe(false);
    expect(condition.raw).toBe("0xabcd");
  });

  test("a record window overrides the meta window", () => {
    const condition = describeCondition({
      mode: 1,
      metaT1: 111,
      metaT2: 222,
      record: { ...priceRecord, t1: 333, t2: 444 },
    });
    expect(condition.window).toEqual({ t1: 333, t2: 444 });
  });

  test("a record without a price clause falls back to the meta window", () => {
    const condition = describeCondition({
      mode: 1,
      metaT1: 111,
      metaT2: 222,
      record: { ...priceRecord, comparator: COMPARATOR_NONE, t1: 0, t2: 0 },
    });
    expect(condition.price).toBeNull();
    expect(condition.window).toEqual({ t1: 111, t2: 222 });
  });

  test("a Private covenant without a record reports a sealed threshold", () => {
    const condition = describeCondition({
      mode: 0,
      metaT1: 0,
      metaT2: 0,
      record: null,
    });
    expect(condition.sealed).toBe(true);
    expect(condition.price).toBeNull();
    expect(condition.window).toBeNull();
    expect(condition.raw).toBeNull();
  });

  test("a public covenant without a record shows only its meta window", () => {
    const condition = describeCondition({
      mode: 1,
      metaT1: 500,
      metaT2: 600,
      record: null,
    });
    expect(condition.sealed).toBe(false);
    expect(condition.window).toEqual({ t1: 500, t2: 600 });
  });
});

describe("opSymbol", () => {
  test("maps comparators and passes anything else through", () => {
    expect(opSymbol(">=")).toBe("≥");
    expect(opSymbol("<=")).toBe("≤");
    expect(opSymbol("==")).toBe("==");
  });
});

describe("triggerText", () => {
  const price = {
    asset: "ETH",
    op: ">=",
    threshold1e8: "500000000000",
    thresholdUsd: "5000",
  };
  test("renders a price clause", () => {
    expect(triggerText(price, null, false)).toBe("ETH ≥ $5,000");
  });
  test("renders a price clause with a window", () => {
    expect(triggerText(price, { t1: 0, t2: 1760000000 }, false)).toContain(
      "ETH ≥ $5,000 by ",
    );
  });
  test("renders a window-only trigger", () => {
    expect(triggerText(null, { t1: 0, t2: 1760000000 }, false)).toMatch(/^by /);
  });
  test("renders a sealed trigger", () => {
    expect(triggerText(null, null, true)).toBe("a sealed trigger");
  });
  test("renders an empty trigger as a dash", () => {
    expect(triggerText(null, null, false)).toBe("—");
  });
});
