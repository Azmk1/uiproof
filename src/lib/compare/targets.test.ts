import { describe, expect, it } from "vitest";
import {
  COMPARISON_TARGETS,
  DEFAULT_VIEWPORT_ID,
  VIEWPORT_PRESETS,
  buildCaptureUrl,
  getTarget,
  getViewport,
  isAllowedDemoRoute,
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

  it("refuses untrusted routes and origins", () => {
    expect(() => buildCaptureUrl("http://localhost:3000", "https://example.com")).toThrow(RangeError);
    expect(() => buildCaptureUrl("http://localhost:3000", "/demo/../secrets")).toThrow(RangeError);
    expect(() => buildCaptureUrl("ftp://localhost:3000", "/demo/baseline")).toThrow(RangeError);
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
});
