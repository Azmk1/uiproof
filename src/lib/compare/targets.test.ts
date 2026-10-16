import { describe, expect, it } from "vitest";
import {
  COMPARISON_TARGETS,
  DEFAULT_VIEWPORT_ID,
  VIEWPORT_PRESETS,
  buildCaptureUrl,
  getTarget,
  getTargetVariants,
  getVariant,
  getViewport,
  isAllowedDemoRoute,
  resolveCurrentRoute,
  targetSupportsMode,
} from "./targets";

describe("isAllowedDemoRoute", () => {
  it("accepts the local fixture routes", () => {
    expect(isAllowedDemoRoute("/demo/baseline")).toBe(true);
    expect(isAllowedDemoRoute("/demo/current")).toBe(true);
    expect(isAllowedDemoRoute("/demo/marketing/hero")).toBe(true);
  });

  it("rejects absolute, protocol-relative and off-prefix URLs", () => {
    expect(isAllowedDemoRoute("https://example.com")).toBe(false);
    expect(isAllowedDemoRoute("http://localhost:3000/demo/baseline")).toBe(false);
    expect(isAllowedDemoRoute("//example.com/demo/baseline")).toBe(false);
    expect(isAllowedDemoRoute("/etc/passwd")).toBe(false);
    expect(isAllowedDemoRoute("/demo")).toBe(false);
    expect(isAllowedDemoRoute("/demo/../admin")).toBe(false);
    expect(isAllowedDemoRoute("/DEMO/baseline")).toBe(false);
  });

  it("rejects query strings, fragments, spaces and non-strings", () => {
    expect(isAllowedDemoRoute("/demo/baseline?token=1")).toBe(false);
    expect(isAllowedDemoRoute("/demo/baseline#top")).toBe(false);
    expect(isAllowedDemoRoute("/demo/base line")).toBe(false);
    expect(isAllowedDemoRoute("/demo/ba:seline")).toBe(false);
    expect(isAllowedDemoRoute("/demo\\baseline")).toBe(false);
    expect(isAllowedDemoRoute(undefined)).toBe(false);
    expect(isAllowedDemoRoute(42)).toBe(false);
    expect(isAllowedDemoRoute("")).toBe(false);
  });

  it("rejects every form of query string, including plausible ones", () => {
    for (const route of [
      "/demo/current?variant=original",
      "/demo/current?redirect=https://evil.example",
      "/demo/current?",
      "/demo/current??variant=original",
      "/demo/../admin?variant=original",
      "/demo/current?variant=original%00",
    ]) {
      expect(isAllowedDemoRoute(route), route).toBe(false);
    }
  });

  it("rejects absurdly long routes", () => {
    expect(isAllowedDemoRoute(`/demo/${"a".repeat(200)}`)).toBe(false);
  });
});

describe("buildCaptureUrl", () => {
  it("resolves an allow-listed route against the UIProof origin", () => {
    const url = buildCaptureUrl("http://localhost:3000", "/demo/baseline");
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/demo/baseline");
    expect(url.search).toBe("");
  });

  it("produces a URL with no query or fragment, whatever the route", () => {
    const url = buildCaptureUrl("http://localhost:3000", "/demo/reverted");
    expect(url.pathname).toBe("/demo/reverted");
    expect(url.search).toBe("");
    expect(url.toString()).toBe("http://localhost:3000/demo/reverted");
  });

  it("refuses untrusted routes and origins", () => {
    expect(() => buildCaptureUrl("http://localhost:3000", "https://example.com")).toThrow(RangeError);
    expect(() => buildCaptureUrl("http://localhost:3000", "/demo/../secrets")).toThrow(RangeError);
    expect(() => buildCaptureUrl("ftp://localhost:3000", "/demo/baseline")).toThrow(RangeError);
    expect(() => buildCaptureUrl("http://localhost:3000", "/demo/current?token=1")).toThrow(RangeError);
  });
});

describe("catalogue", () => {
  it("exposes one desktop-first preset set", () => {
    expect(getViewport(DEFAULT_VIEWPORT_ID)?.width).toBe(1280);
    expect(getViewport("mobile")?.height).toBe(844);
    expect(getViewport("nope")).toBeUndefined();
    expect(VIEWPORT_PRESETS.every((preset) => preset.width > 0 && preset.height > 0)).toBe(true);
  });

  it("only ever points targets at allow-listed routes", () => {
    expect(COMPARISON_TARGETS.length).toBeGreaterThan(0);
    for (const target of COMPARISON_TARGETS) {
      expect(isAllowedDemoRoute(target.baseline.path)).toBe(true);
      expect(isAllowedDemoRoute(target.current.path)).toBe(true);
    }
  });

  it("looks targets up by id and rejects anything else", () => {
    expect(getTarget("invoice-summary")?.baseline.path).toBe("/demo/baseline");
    expect(getTarget("unknown")).toBeUndefined();
    expect(getTarget(undefined)).toBeUndefined();
    expect(getTarget({ id: "invoice-summary" })).toBeUndefined();
  });

  it("declares supported modes and defaults to the fixture pair", () => {
    const invoice = getTarget("invoice-summary");
    const control = getTarget("baseline-control");
    expect(invoice && targetSupportsMode(invoice, "baseline")).toBe(true);
    expect(invoice && targetSupportsMode(invoice, "fixture")).toBe(true);
    expect(control && targetSupportsMode(control, "baseline")).toBe(false);
    expect(COMPARISON_TARGETS.every((target) => target.modes.includes(target.defaultMode))).toBe(true);
  });

  it("only exposes allow-listed variant routes", () => {
    for (const target of COMPARISON_TARGETS) {
      const variants = getTargetVariants(target);
      expect(variants.length === 0 || target.defaultVariantId !== undefined).toBe(true);
      for (const variant of variants) {
        expect(isAllowedDemoRoute(variant.route)).toBe(true);
      }
      if (variants.length > 0) {
        expect(getVariant(target, target.defaultVariantId)?.id).toBe(target.defaultVariantId);
      }
    }
  });
});

describe("resolveCurrentRoute", () => {
  const invoice = getTarget("invoice-summary")!;

  it("defaults to the shipped page and switches to the reverted one", () => {
    expect(resolveCurrentRoute(invoice, undefined)).toBe("/demo/current");
    expect(resolveCurrentRoute(invoice, "shipped")).toBe("/demo/current");
    expect(resolveCurrentRoute(invoice, "reverted")).toBe("/demo/reverted");
  });

  it("refuses unknown states and states a target cannot offer", () => {
    expect(() => resolveCurrentRoute(invoice, "drifted")).toThrow(RangeError);
    const control = getTarget("baseline-control")!;
    expect(resolveCurrentRoute(control, undefined)).toBe("/demo/baseline");
    expect(() => resolveCurrentRoute(control, "shipped")).toThrow(RangeError);
  });
});
