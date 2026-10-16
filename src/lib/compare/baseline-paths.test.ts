import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineImageUrl,
  isValidBaselineVersionFileName,
  isValidBaselineVersionId,
  resolveBaselineDir,
  resolveBaselineManifestPath,
  resolveBaselineVersionPath,
  versionFileName,
} from "./baseline-paths";

const CWD = path.join("tmp", "uiproof-baseline-paths");
const VERSION_ID = "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab";

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
  it("places a pair inside the data directory", () => {
    const dir = resolveBaselineDir("invoice-summary", "desktop", CWD);
    expect(dir.endsWith(path.join(".uiproof", "data", "baselines", "invoice-summary", "desktop"))).toBe(true);
    expect(dir.startsWith(path.resolve(CWD))).toBe(true);
  });

  it("refuses unknown targets and viewports, so they can never become paths", () => {
    expect(() => resolveBaselineDir("../../etc", "desktop", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineDir("invoice-summary", "../../etc", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineDir("unknown-target", "desktop", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineDir("invoice-summary", "watch", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineManifestPath("invoice-summary", "nope", CWD)).toThrow(RangeError);
  });

  it("keeps the manifest and version files inside the pair directory", () => {
    const dir = path.resolve(resolveBaselineDir("invoice-summary", "mobile", CWD));
    expect(resolveBaselineManifestPath("invoice-summary", "mobile", CWD)).toBe(path.join(dir, "manifest.json"));
    expect(resolveBaselineVersionPath("invoice-summary", "mobile", VERSION_ID, CWD)).toBe(
      path.join(dir, "versions", `${VERSION_ID}.png`),
    );
    expect(() => resolveBaselineVersionPath("invoice-summary", "mobile", "../../secret.png", CWD)).toThrow(RangeError);
    expect(() => resolveBaselineVersionPath("../../etc", "mobile", VERSION_ID, CWD)).toThrow(RangeError);
  });
});

describe("baselineImageUrl", () => {
  it("builds the application-relative image URL", () => {
    expect(baselineImageUrl("invoice-summary", "desktop", VERSION_ID)).toBe(
      `/api/baselines/invoice-summary/desktop/${VERSION_ID}.png`,
    );
  });
});
