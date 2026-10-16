import { describe, expect, it } from "vitest";
import { ComparisonError } from "./errors";
import {
  baselineScopeOf,
  DEFAULT_MODE,
  parseComparisonMode,
  parseVariantId,
  requireTarget,
  resolveRun,
  resolveRunSource,
} from "./run-options";
import { getTarget } from "./targets";
import { parseProjectConfig } from "@/lib/projects/registry";
import type { RegisteredProject } from "./types";

const UI_PROOF_ORIGIN = "http://127.0.0.1:3000";

const projects: readonly RegisteredProject[] = parseProjectConfig(
  JSON.stringify({
    projects: [
      {
        id: "example-app",
        name: "Example app",
        origin: "http://127.0.0.1:4173",
        routes: [
          { id: "home", name: "Home", path: "/" },
          { id: "checkout", name: "Checkout", path: "/checkout" },
        ],
        allowedOrigins: ["https://fonts.example"],
      },
    ],
  }),
).projects;

function resolve(overrides: Partial<Parameters<typeof resolveRun>[0]> = {}) {
  return resolveRun({
    targetId: "invoice-summary",
    mode: undefined,
    variantId: undefined,
    uiProofOrigin: UI_PROOF_ORIGIN,
    projects,
    ...overrides,
  });
}

describe("parseComparisonMode", () => {
  it("defaults to the fixture pair so Phase 1 callers keep working", () => {
    expect(parseComparisonMode(undefined)).toBe(DEFAULT_MODE);
    expect(parseComparisonMode(null)).toBe("fixture");
    expect(parseComparisonMode("fixture")).toBe("fixture");
    expect(parseComparisonMode("baseline")).toBe("baseline");
    expect(parseComparisonMode("capture")).toBe("capture");
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

describe("resolveRunSource (demo)", () => {
  it("resolves the Phase 1/2 target spelling", () => {
    const source = resolveRunSource({ targetId: "invoice-summary", projects, uiProofOrigin: UI_PROOF_ORIGIN });
    expect(source.kind).toBe("demo");
    expect(source.scopeKey).toBe("demo:invoice-summary");
    expect(source.label).toBe("Invoice summary card");
    expect(source.origin).toBe(UI_PROOF_ORIGIN);
    expect(source.fixtureBaselinePath).toBe("/demo/baseline");
    expect(source.modes).toEqual(["fixture", "baseline", "capture"]);
  });

  it("accepts the Phase 3 spelling of the same thing", () => {
    const source = resolveRunSource({
      source: { kind: "demo", targetId: "invoice-summary" },
      projects,
      uiProofOrigin: UI_PROOF_ORIGIN,
    });
    expect(source.scopeKey).toBe("demo:invoice-summary");
    // The request body's targetId is ignored when a source is given.
    const withBoth = resolveRunSource({
      source: { kind: "demo", targetId: "invoice-summary" },
      targetId: "baseline-control",
      projects,
      uiProofOrigin: UI_PROOF_ORIGIN,
    });
    expect(withBoth.scopeKey).toBe("demo:invoice-summary");
  });

  it("refuses unknown targets and hostile ids", () => {
    for (const targetId of ["nope", "https://evil.example", "../../etc", 42, null, undefined]) {
      expect(() => resolveRunSource({ targetId, projects, uiProofOrigin: UI_PROOF_ORIGIN }), String(targetId)).toThrow(
        ComparisonError,
      );
    }
  });
});

describe("resolveRunSource (registered project)", () => {
  it("resolves a registered route to its own origin and allow-list", () => {
    const source = resolveRunSource({
      source: { kind: "project", projectId: "example-app", routeId: "checkout" },
      projects,
      uiProofOrigin: UI_PROOF_ORIGIN,
    });
    expect(source.kind).toBe("project");
    expect(source.scopeKey).toBe("project:example-app/checkout");
    expect(source.label).toBe("Example app · Checkout");
    expect(source.origin).toBe("http://127.0.0.1:4173");
    expect(source.path).toBe("/checkout");
    expect(source.fixtureBaselinePath).toBeNull();
    expect(source.modes).toEqual(["capture", "baseline"]);
    expect(source.allowedOrigins).toEqual(["https://fonts.example"]);
  });

  it("infers the project kind when only ids are sent", () => {
    const source = resolveRunSource({
      source: { projectId: "example-app", routeId: "home" },
      projects,
      uiProofOrigin: UI_PROOF_ORIGIN,
    });
    expect(source.kind).toBe("project");
    expect(source.scopeKey).toBe("project:example-app/home");
  });

  it("refuses projects and routes that are not registered", () => {
    const cases: Array<{ source: Record<string, unknown>; code: string }> = [
      { source: { kind: "project", projectId: "ghost", routeId: "home" }, code: "project_not_registered" },
      { source: { kind: "project", projectId: "example-app", routeId: "ghost" }, code: "route_not_registered" },
      { source: { kind: "project", projectId: "../../etc", routeId: "home" }, code: "project_not_registered" },
      { source: { kind: "project", projectId: "example-app" }, code: "route_not_registered" },
      { source: { kind: "project", projectId: "https://evil.example", routeId: "home" }, code: "project_not_registered" },
    ];
    for (const testCase of cases) {
      try {
        resolveRunSource({ source: testCase.source, projects, uiProofOrigin: UI_PROOF_ORIGIN });
        throw new Error("expected a ComparisonError");
      } catch (error) {
        expect(error, JSON.stringify(testCase.source)).toBeInstanceOf(ComparisonError);
        expect((error as ComparisonError).code, JSON.stringify(testCase.source)).toBe(testCase.code);
        expect((error as ComparisonError).status).toBe(400);
      }
    }
  });

  it("refuses any project capture while the configuration file is unusable", () => {
    try {
      resolveRunSource({
        source: { kind: "project", projectId: "example-app", routeId: "home" },
        projects: [],
        projectConfigError: "project \"example-app\" needs an \"origin\" …",
        uiProofOrigin: UI_PROOF_ORIGIN,
      });
      throw new Error("expected a ComparisonError");
    } catch (error) {
      expect((error as ComparisonError).code).toBe("project_config_invalid");
      expect((error as ComparisonError).message).toMatch(/origin/);
    }
  });

  it("refuses an unknown source kind instead of falling back to a demo", () => {
    expect(() =>
      resolveRunSource({
        source: { kind: "url", url: "https://evil.example" },
        projects,
        uiProofOrigin: UI_PROOF_ORIGIN,
      }),
    ).toThrow(/source\.kind/);
  });
});

describe("resolveRun", () => {
  it("resolves the shipped page by default and the reverted page on request", () => {
    expect(resolve({ mode: "baseline" })).toMatchObject({
      mode: "baseline",
      variantId: "shipped",
      currentRoute: "/demo/current",
    });
    expect(resolve({ mode: "baseline", variantId: "reverted" }).currentRoute).toBe("/demo/reverted");
  });

  it("refuses a mode the source does not offer", () => {
    try {
      resolve({ targetId: "baseline-control", mode: "baseline" });
      throw new Error("expected a ComparisonError");
    } catch (error) {
      expect((error as ComparisonError).code).toBe("mode_unavailable");
      expect((error as ComparisonError).status).toBe(400);
    }
  });

  it("refuses fixture comparison for a registered project route", () => {
    try {
      resolve({ source: { kind: "project", projectId: "example-app", routeId: "home" }, mode: "fixture" });
      throw new Error("expected a ComparisonError");
    } catch (error) {
      expect((error as ComparisonError).code).toBe("mode_unavailable");
      expect((error as ComparisonError).message).toMatch(/capture, baseline/);
    }
  });

  it("defaults a project route to a plain capture", () => {
    const run = resolve({ source: { kind: "project", projectId: "example-app", routeId: "home" } });
    expect(run.mode).toBe("capture");
    expect(run.variantId).toBeNull();
    expect(run.currentRoute).toBe("/");
  });

  it("defaults a demo target to the fixture pair", () => {
    expect(resolve({}).mode).toBe("fixture");
  });

  it("refuses a page state where none exist", () => {
    for (const variantId of ["shipped", "reverted", 5]) {
      try {
        resolve({ source: { kind: "project", projectId: "example-app", routeId: "home" }, variantId });
        throw new Error("expected a ComparisonError");
      } catch (error) {
        expect((error as ComparisonError).code).toBe("invalid_options");
      }
    }
    try {
      resolve({ targetId: "baseline-control", variantId: "shipped" });
      throw new Error("expected a ComparisonError");
    } catch (error) {
      expect((error as ComparisonError).code).toBe("invalid_options");
    }
  });

  it("reports unknown page states as invalid options", () => {
    for (const variantId of ["drifted", 5]) {
      try {
        resolve({ mode: "fixture", variantId });
        throw new Error("expected a ComparisonError");
      } catch (error) {
        expect((error as ComparisonError).code).toBe("invalid_options");
        expect((error as ComparisonError).status).toBe(400);
      }
    }
  });
});

describe("baselineScopeOf", () => {
  it("maps a demo source and a project source to their scopes", () => {
    expect(baselineScopeOf(resolve({ mode: "capture" }).source)).toEqual({
      kind: "demo",
      targetId: "invoice-summary",
    });
    expect(
      baselineScopeOf(resolve({ source: { kind: "project", projectId: "example-app", routeId: "checkout" } }).source),
    ).toEqual({ kind: "project", projectId: "example-app", routeId: "checkout" });
  });
});

describe("requireTarget", () => {
  it("resolves catalogue ids and refuses anything else", () => {
    expect(requireTarget("invoice-summary").id).toBe("invoice-summary");
    for (const value of ["nope", undefined, 42, { id: "invoice-summary" }]) {
      expect(() => requireTarget(value)).toThrow(ComparisonError);
    }
  });

  it("knows every catalogue target", () => {
    expect(getTarget("baseline-control")?.label).toBe("Control · same page twice");
  });
});
