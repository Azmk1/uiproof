import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineImageUrl,
  baselineScopeKey,
  isValidBaselineVersionFileName,
  isValidBaselineVersionId,
  parseBaselineScope,
  parseBaselineScopeKey,
  resolveBaselineDir,
  resolveBaselineManifestPath,
  resolveBaselineVersionPath,
  versionFileName,
} from "./baseline-paths";
import { COMPARISON_TARGETS } from "./targets";
import type { BaselineScope } from "./types";

const CWD = path.join("tmp", "uiproof-baseline-paths");
const VERSION_ID = "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab";

const INVOICE: BaselineScope = { kind: "demo", targetId: "invoice-summary" };
const EXAMPLE_HOME: BaselineScope = { kind: "project", projectId: "example-app", routeId: "home" };

describe("baseline version ids", () => {
  it("accepts only ids this codebase generates", () => {
    expect(isValidBaselineVersionId(VERSION_ID)).toBe(true);
    for (const value of [
      "bl-abc",
      "run-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
      "BL-8F0C1D2E-3A4B-4C5D-8E9F-0123456789AB",
      `${VERSION_ID}.png`,
      "../../etc/passwd",
      "",
      42,
      null,
    ]) {
      expect(isValidBaselineVersionId(value), String(value)).toBe(false);
    }
  });

  it("accepts only the matching png file name", () => {
    expect(isValidBaselineVersionFileName(`${VERSION_ID}.png`)).toBe(true);
    expect(isValidBaselineVersionFileName("bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab.PNG")).toBe(false);
    expect(isValidBaselineVersionFileName("diff.png")).toBe(false);
    expect(isValidBaselineVersionFileName(`../${VERSION_ID}.png`)).toBe(false);
    expect(isValidBaselineVersionFileName(`${VERSION_ID}.png.exe`)).toBe(false);
  });

  it("builds the file name from a validated id", () => {
    expect(versionFileName(VERSION_ID)).toBe(`${VERSION_ID}.png`);
    expect(() => versionFileName("nope")).toThrow(RangeError);
  });
});

describe("baseline directories", () => {
  it("keeps the demo layout exactly as Phase 2 wrote it", () => {
    const dir = resolveBaselineDir(INVOICE, "desktop", CWD);
    expect(dir.endsWith(path.join(".uiproof", "data", "baselines", "invoice-summary", "desktop"))).toBe(true);
    expect(dir.startsWith(path.resolve(CWD))).toBe(true);
  });

  it("namespaces project baselines under projects/", () => {
    const dir = resolveBaselineDir(EXAMPLE_HOME, "desktop", CWD);
    expect(dir.endsWith(path.join(".uiproof", "data", "baselines", "projects", "example-app", "home", "desktop"))).toBe(
      true,
    );
    // A project id can never resolve into the demo namespace, or the other way round.
    const projectAsDemo = resolveBaselineDir({ kind: "project", projectId: "example-app", routeId: "home" }, "desktop", CWD);
    expect(path.relative(path.resolve(CWD), projectAsDemo).startsWith(path.join(".uiproof", "data", "baselines", "projects"))).toBe(
      true,
    );
  });

  it("reserves the projects namespace, so no demo target can collide with it", () => {
    expect(COMPARISON_TARGETS.map((target) => target.id)).not.toContain("projects");
  });

  it("refuses unknown scopes and viewports, so they can never become paths", () => {
    for (const scope of [
      { kind: "demo", targetId: "../../etc" },
      { kind: "demo", targetId: "unknown-target" },
      { kind: "demo", targetId: "projects" },
      { kind: "project", projectId: "../../etc", routeId: "home" },
      { kind: "project", projectId: "Example-App", routeId: "home" },
      { kind: "project", projectId: "example-app", routeId: "../home" },
      { kind: "project", projectId: "example-app", routeId: "home/../.." },
      { kind: "project", projectId: "", routeId: "" },
      { kind: "something-else", targetId: "invoice-summary" },
      null,
    ]) {
      expect(() => resolveBaselineDir(scope, "desktop", CWD), JSON.stringify(scope)).toThrow(RangeError);
    }
    expect(() => resolveBaselineDir(INVOICE, "../../etc", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineDir(INVOICE, "watch", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineManifestPath(INVOICE, "nope", CWD)).toThrow(RangeError);
  });

  it("keeps the manifest and version files inside the scope directory", () => {
    const dir = path.resolve(resolveBaselineDir(INVOICE, "mobile", CWD));
    expect(resolveBaselineManifestPath(INVOICE, "mobile", CWD)).toBe(path.join(dir, "manifest.json"));
    expect(resolveBaselineVersionPath(INVOICE, "mobile", VERSION_ID, CWD)).toBe(
      path.join(dir, "versions", `${VERSION_ID}.png`),
    );
    expect(() => resolveBaselineVersionPath(INVOICE, "mobile", "../../secret.png", CWD)).toThrow(RangeError);

    const projectDir = path.resolve(resolveBaselineDir(EXAMPLE_HOME, "mobile", CWD));
    expect(resolveBaselineVersionPath(EXAMPLE_HOME, "mobile", VERSION_ID, CWD)).toBe(
      path.join(projectDir, "versions", `${VERSION_ID}.png`),
    );
  });
});

describe("baseline scope keys", () => {
  it("round-trips demo and project scopes", () => {
    expect(baselineScopeKey(INVOICE)).toBe("demo:invoice-summary");
    expect(baselineScopeKey(EXAMPLE_HOME)).toBe("project:example-app/home");
    expect(parseBaselineScopeKey("demo:invoice-summary")).toEqual(INVOICE);
    expect(parseBaselineScopeKey("project:example-app/home")).toEqual(EXAMPLE_HOME);
  });

  it("refuses malformed keys instead of guessing", () => {
    for (const key of ["invoice-summary", "demo:../../etc", "project:example-app", "project:/home", "", 42, null]) {
      expect(() => parseBaselineScopeKey(key), String(key)).toThrow(RangeError);
    }
  });

  it("validates raw scope objects", () => {
    expect(parseBaselineScope(INVOICE)).toEqual(INVOICE);
    expect(parseBaselineScope(EXAMPLE_HOME)).toEqual(EXAMPLE_HOME);
    expect(() => parseBaselineScope({ kind: "demo" })).toThrow(RangeError);
    expect(() => parseBaselineScope("demo:invoice-summary")).toThrow(RangeError);
  });
});

describe("baselineImageUrl", () => {
  it("builds the application-relative image URL for both namespaces", () => {
    expect(baselineImageUrl(INVOICE, "desktop", VERSION_ID)).toBe(
      `/api/baselines/invoice-summary/desktop/${VERSION_ID}.png`,
    );
    expect(baselineImageUrl(EXAMPLE_HOME, "desktop", VERSION_ID)).toBe(
      `/api/baselines/projects/example-app/home/desktop/${VERSION_ID}.png`,
    );
  });
});
