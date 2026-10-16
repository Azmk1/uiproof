import { describe, expect, it } from "vitest";
import { ComparisonError } from "./errors";
import { DEFAULT_MODE, parseComparisonMode, parseVariantId, requireTarget, resolveRunTarget } from "./run-options";
import { getTarget } from "./targets";

const invoice = getTarget("invoice-summary")!;
const control = getTarget("baseline-control")!;

describe("parseComparisonMode", () => {
  it("defaults to the fixture pair so Phase 1 callers keep working", () => {
    expect(parseComparisonMode(undefined)).toBe(DEFAULT_MODE);
    expect(parseComparisonMode(null)).toBe("fixture");
    expect(parseComparisonMode("fixture")).toBe("fixture");
    expect(parseComparisonMode("baseline")).toBe("baseline");
  });

  it("rejects anything else instead of guessing", () => {
    for (const value of ["drift", "FIXTURE", "", 7, {}, []]) {
      expect(() => parseComparisonMode(value), String(value)).toThrow(RangeError);
    }
  });
});

describe("parseVariantId", () => {
  it("accepts an absent state and a short id", () => {
    expect(parseVariantId(undefined)).toBeNull();
    expect(parseVariantId("reverted")).toBe("reverted");
  });

  it("rejects non-strings and oversized ids", () => {
    expect(() => parseVariantId(12)).toThrow(RangeError);
    expect(() => parseVariantId("")).toThrow(RangeError);
    expect(() => parseVariantId("x".repeat(41))).toThrow(RangeError);
  });
});

describe("resolveRunTarget", () => {
  it("resolves the shipped page by default and the reverted page on request", () => {
    expect(resolveRunTarget({ target: invoice, mode: "baseline", variantId: undefined })).toEqual({
      mode: "baseline",
      variantId: "shipped",
      currentRoute: "/demo/current",
    });
    expect(resolveRunTarget({ target: invoice, mode: "baseline", variantId: "reverted" }).currentRoute).toBe(
      "/demo/reverted",
    );
  });

  it("refuses a mode the target does not offer", () => {
    expect(() => resolveRunTarget({ target: control, mode: "baseline", variantId: undefined })).toThrow(
      ComparisonError,
    );
    try {
      resolveRunTarget({ target: control, mode: "baseline", variantId: undefined });
    } catch (error) {
      expect((error as ComparisonError).code).toBe("mode_unavailable");
      expect((error as ComparisonError).status).toBe(400);
    }
  });

  it("reports unknown page states and states a target cannot offer as invalid options", () => {
    const cases: Array<{ target: typeof invoice; variantId: unknown }> = [
      { target: invoice, variantId: "drifted" },
      { target: invoice, variantId: 5 },
      { target: control, variantId: "shipped" },
    ];
    for (const testCase of cases) {
      try {
        resolveRunTarget({ target: testCase.target, mode: "fixture", variantId: testCase.variantId });
        throw new Error("expected a ComparisonError");
      } catch (error) {
        expect(error).toBeInstanceOf(ComparisonError);
        expect((error as ComparisonError).code).toBe("invalid_options");
        expect((error as ComparisonError).status).toBe(400);
      }
    }
  });
});

describe("requireTarget", () => {
  it("resolves catalogue ids and refuses anything else", () => {
    expect(requireTarget("invoice-summary").id).toBe("invoice-summary");
    for (const value of ["nope", undefined, 42, { id: "invoice-summary" }]) {
      expect(() => requireTarget(value)).toThrow(ComparisonError);
    }
  });
});
