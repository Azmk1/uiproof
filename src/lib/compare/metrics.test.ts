import { describe, expect, it } from "vitest";
import {
  computeChangePercentage,
  computeVerdict,
  formatBytes,
  formatChangePercentage,
  parseMaxDiffPercent,
  DEFAULT_MAX_DIFF_PERCENT,
} from "./metrics";

describe("computeChangePercentage", () => {
  it("returns the share of compared pixels that changed", () => {
    expect(computeChangePercentage(0, 10_000)).toBe(0);
    expect(computeChangePercentage(100, 10_000)).toBe(1);
    expect(computeChangePercentage(2_418, 100_000)).toBeCloseTo(2.418, 6);
  });

  it("never divides by zero or reports impossible ratios", () => {
    expect(computeChangePercentage(10, 0)).toBe(0);
    expect(computeChangePercentage(Number.NaN, 100)).toBe(0);
    expect(computeChangePercentage(500, 100)).toBe(100);
    expect(computeChangePercentage(-5, 100)).toBe(0);
  });
});

describe("computeVerdict", () => {
  it("passes at or below the tolerance and regresses above it", () => {
    expect(computeVerdict(0, 0.1)).toBe("pass");
    expect(computeVerdict(0.1, 0.1)).toBe("pass");
    expect(computeVerdict(0.1001, 0.1)).toBe("regression");
    expect(computeVerdict(12, 0.1)).toBe("regression");
  });

  it("treats a zero tolerance as strictly no changes", () => {
    expect(computeVerdict(0, 0)).toBe("pass");
    expect(computeVerdict(0.0001, 0)).toBe("regression");
  });
});

describe("formatChangePercentage", () => {
  it("formats with at most the requested fraction digits", () => {
    expect(formatChangePercentage(0)).toBe("0");
    expect(formatChangePercentage(2.4178, 3)).toBe("2.418");
    expect(formatChangePercentage(0.0042, 3)).toBe("0.004");
    expect(formatChangePercentage(12.5, 3)).toBe("12.5");
    expect(formatChangePercentage(Number.NaN)).toBe("—");
  });
});

describe("formatBytes", () => {
  it("scales units for artifact sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("parseMaxDiffPercent", () => {
  it("falls back to the default when the value is absent", () => {
    expect(parseMaxDiffPercent(undefined)).toBe(DEFAULT_MAX_DIFF_PERCENT);
    expect(parseMaxDiffPercent(null)).toBe(DEFAULT_MAX_DIFF_PERCENT);
  });

  it("accepts a finite in-range percentage", () => {
    expect(parseMaxDiffPercent(0)).toBe(0);
    expect(parseMaxDiffPercent(2.5)).toBe(2.5);
    expect(parseMaxDiffPercent(1.23456)).toBe(1.2346);
  });

  it("rejects anything else so the API can answer 400", () => {
    expect(() => parseMaxDiffPercent("5")).toThrow(RangeError);
    expect(() => parseMaxDiffPercent(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => parseMaxDiffPercent(-1)).toThrow(RangeError);
    expect(() => parseMaxDiffPercent(101)).toThrow(RangeError);
  });
});
