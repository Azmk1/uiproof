import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidFileName,
  isValidReportId,
  resolveArtifactPath,
  resolveReportDir,
  resolveReportsDir,
} from "./storage-paths";

const CWD = path.join("tmp", "uiproof-test");
const REPORTS_DIR = path.resolve(resolveReportsDir(CWD));

describe("isValidReportId", () => {
  it("accepts generated run ids", () => {
    expect(isValidReportId("run-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab")).toBe(true);
    expect(isValidReportId("run-abc")).toBe(true);
  });

  it("rejects traversal, separators and non-strings", () => {
    expect(isValidReportId("../etc")).toBe(false);
    expect(isValidReportId("run-../x")).toBe(false);
    expect(isValidReportId("run/child")).toBe(false);
    expect(isValidReportId("run\\child")).toBe(false);
    expect(isValidReportId("RUN-UPPER")).toBe(false);
    expect(isValidReportId("")).toBe(false);
    expect(isValidReportId(42)).toBe(false);
    expect(isValidReportId(null)).toBe(false);
  });
});

describe("isValidFileName", () => {
  it("accepts the artifact and report files only", () => {
    expect(isValidFileName("baseline.png")).toBe(true);
    expect(isValidFileName("current.png")).toBe(true);
    expect(isValidFileName("diff.png")).toBe(true);
    expect(isValidFileName("report.json")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidFileName("../../secret.png")).toBe(false);
    expect(isValidFileName("baseline.txt")).toBe(false);
    expect(isValidFileName("baseline.PNG")).toBe(false);
    expect(isValidFileName("sub/diff.png")).toBe(false);
    expect(isValidFileName(undefined)).toBe(false);
  });
});

describe("resolveReportDir", () => {
  it("keeps runs inside the reports directory", () => {
    expect(resolveReportDir("run-abc", CWD)).toBe(path.join(REPORTS_DIR, "run-abc"));
  });

  it("throws for unsafe ids", () => {
    expect(() => resolveReportDir("../../etc", CWD)).toThrow(RangeError);
    expect(() => resolveReportDir("run-abc/child", CWD)).toThrow(RangeError);
  });
});

describe("resolveArtifactPath", () => {
  it("resolves a known artifact inside the run directory", () => {
    expect(resolveArtifactPath("run-abc", "diff.png", CWD)).toBe(
      path.join(REPORTS_DIR, "run-abc", "diff.png"),
    );
    expect(resolveArtifactPath("run-abc", "diff.png", CWD).startsWith(REPORTS_DIR)).toBe(true);
  });

  it("refuses traversal through either segment", () => {
    expect(() => resolveArtifactPath("../../etc", "diff.png", CWD)).toThrow(RangeError);
    expect(() => resolveArtifactPath("run-abc", "../../../etc/passwd", CWD)).toThrow(RangeError);
    expect(() => resolveArtifactPath("run-abc", "evil.sh", CWD)).toThrow(RangeError);
  });
});
