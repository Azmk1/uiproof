import { describe, expect, it } from "vitest";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import type {
  RepairAccessibilityMeasure,
  RepairLayoutMeasure,
  RepairMeasurement,
  RepairPageMeasurement,
  RepairVisualMeasure,
  SandboxCommandResult,
  ScopeCheck,
} from "./types";
import { invalidateForSourceDrift, sourceDriftDetail, verifyRepair } from "./verify";

const CLEAN_A11Y: RepairAccessibilityMeasure = {
  violations: 0,
  serious: 0,
  critical: 0,
  fingerprints: [],
  impactByFingerprint: {},
  byImpact: { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 },
};

const CLEAN_LAYOUT: RepairLayoutMeasure = { documentOverflowPx: 0, defects: [], scrollableRegions: [] };

const NO_VISUAL: RepairVisualMeasure = {
  baselineVersionId: "",
  changedPixels: 0,
  changePercentage: 0,
  tolerance: 0.1,
  dimensionsChanged: false,
  status: "no-baseline",
  detail: "no baseline",
};

function a11y(fingerprints: Record<string, "minor" | "moderate" | "serious" | "critical">): RepairAccessibilityMeasure {
  const entries = Object.entries(fingerprints);
  const counts = { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 };
  for (const [, impact] of entries) counts[impact] += 1;
  return {
    violations: entries.length,
    serious: counts.serious,
    critical: counts.critical,
    fingerprints: entries.map(([fingerprint]) => fingerprint).sort(),
    impactByFingerprint: Object.fromEntries(entries),
    byImpact: counts,
  };
}

function page(overrides: Partial<RepairPageMeasurement> = {}): RepairPageMeasurement {
  return {
    routeId: "support",
    path: "/support",
    viewportId: "mobile",
    viewportLabel: "Mobile",
    accessibility: CLEAN_A11Y,
    layout: CLEAN_LAYOUT,
    visual: NO_VISUAL,
    screenshot: "before-support-mobile.png",
    diff: null,
    measuredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function measurement(phase: "before" | "after", pages: RepairPageMeasurement[]): RepairMeasurement {
  return { phase, startedAt: "2026-01-01T00:00:00.000Z", totalMs: 10, pages, warnings: [] };
}

const OK_SCOPE: ScopeCheck = { ok: true, files: ["views/page.html"], violations: [] };

function command(name: "build" | "test", status: "passed" | "failed" | "skipped" = "passed"): SandboxCommandResult {
  return {
    name,
    command: ["node", `${name}.mjs`],
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    durationMs: 5,
    outputTail: "",
    reason: status === "skipped" ? `${name} was not configured.` : null,
  };
}

const TARGET: DiagnosticIssue = {
  key: "a11y:label@#support-email",
  kind: "accessibility",
  title: "label on #support-email",
  measured: [],
  evidence: [],
};

const OVERFLOW_TARGET: DiagnosticIssue = {
  key: "responsive:mobile",
  kind: "responsive",
  title: "Horizontal overflow at Mobile",
  measured: [],
  evidence: [],
};

const VISUAL_TARGET: DiagnosticIssue = {
  key: "visual:regression",
  kind: "visual",
  title: "Visual regression on Example app",
  measured: [],
  evidence: [],
};

const visual = (status: RepairVisualMeasure["status"], changePercentage: number, dimensionsChanged = false): RepairVisualMeasure => ({
  baselineVersionId: "bl-1",
  changedPixels: 100,
  changePercentage,
  tolerance: 0.1,
  dimensionsChanged,
  status,
  detail: `status ${status}`,
});

describe("verifyRepair", () => {
  const before = measurement("before", [
    page({ accessibility: a11y({ "label@#support-email": "critical" }) }),
  ]);
  const fixed = measurement("after", [page()]);

  it("verifies a patch that removes the defect with no regression", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("verified");
    expect(result.targets[0].status).toBe("fixed");
    expect(result.reasons[0]).toMatch(/Every target defect is gone/);
  });

  it("rejects a patch that fixes the target but adds a serious finding", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: measurement("after", [page({ accessibility: a11y({ "color-contrast@.note": "serious" }) })]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.regressions.some((check) => check.id.endsWith(":new-serious"))).toBe(true);
  });

  it("records a new minor finding without rejecting the repair", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: measurement("after", [page({ accessibility: a11y({ "landmark-one-main@body": "moderate" }) })]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("verified");
    expect(result.notes[0]).toMatch(/minor\/moderate/);
  });

  it("rejects a failing build even when the defect is gone", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build", "failed"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.regressions.some((check) => check.kind === "build")).toBe(true);
  });

  it("never calls a repair verified when the build or test was skipped", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build"), command("test", "skipped")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("unverified");
    expect(result.reasons.join(" ")).toMatch(/could not be verified/);
  });

  it("rejects a patch that changes nothing measurable", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: measurement("after", [page({ accessibility: a11y({ "label@#support-email": "critical" }) })]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.targets[0].status).toBe("unchanged");
  });

  it("reports unable to verify when the stored defect is not reproduced", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before: measurement("before", [page()]),
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("unverified");
    expect(result.targets[0].status).toBe("not-measured");
  });

  it("partially improves responsive overflow that shrinks but still exceeds the limit", () => {
    const result = verifyRepair({
      targetIssues: [OVERFLOW_TARGET],
      targetRoutePath: "/support",
      before: measurement("before", [
        page({ layout: { documentOverflowPx: 220, defects: [{ selector: "#banner", overflowPx: 200 }], scrollableRegions: [] } }),
      ]),
      after: measurement("after", [
        page({ layout: { documentOverflowPx: 40, defects: [{ selector: "#banner", overflowPx: 20 }], scrollableRegions: [] } }),
      ]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("partially-improved");
    expect(result.targets[0].status).toBe("improved");
  });

  it("rejects a repair that makes previously clean layout overflow", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: measurement("after", [
        page({
          accessibility: CLEAN_A11Y,
          layout: { documentOverflowPx: 80, defects: [{ selector: "#new", overflowPx: 70 }], scrollableRegions: [] },
        }),
      ]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.regressions.filter((check) => check.kind === "layout")).toHaveLength(2);
  });

  it("verifies a visual regression that returns to the baseline", () => {
    const visualBefore = measurement("before", [page({ visual: visual("regressed", 4.2) })]);
    const visualAfter = measurement("after", [page({ visual: visual("match", 0.02) })]);
    const result = verifyRepair({
      targetIssues: [VISUAL_TARGET],
      targetRoutePath: "/support",
      before: visualBefore,
      after: visualAfter,
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("verified");
  });

  it("rejects a visual repair that changes the page dimensions", () => {
    const result = verifyRepair({
      targetIssues: [VISUAL_TARGET],
      targetRoutePath: "/support",
      before: measurement("before", [page({ visual: visual("regressed", 4.2) })]),
      after: measurement("after", [page({ visual: visual("match", 0, true) })]),
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.regressions.some((check) => check.id.endsWith(":dimensions"))).toBe(true);
  });

  it("never verifies when no build or test result was recorded at all", () => {
    const noResults = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [],
      overflowLimitPx: 1,
    });
    expect(noResults.verdict).toBe("unverified");
    expect(noResults.regressions.some((check) => check.id === "commands-complete")).toBe(true);
    expect(noResults.reasons.join(" ")).toMatch(/No passing build and test result was recorded/);
  });

  it("never verifies when only one of the two configured commands reported back", () => {
    const half = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build")],
      overflowLimitPx: 1,
    });
    expect(half.verdict).toBe("unverified");
    expect(half.regressions.some((check) => check.id === "commands-complete")).toBe(true);
  });

  it("leaves the candidate unverified when a guard route was measured before but not after", () => {
    const withGuard = measurement("before", [
      page({ accessibility: a11y({ "label@#support-email": "critical" }) }),
      page({ routeId: "manual", path: "/manual" }),
    ]);
    const onlyTarget = measurement("after", [page()]);
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before: withGuard,
      after: onlyTarget,
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("unverified");
    const missing = result.regressions.find((check) => check.id === "manual@mobile:missing-after");
    expect(missing?.status).toBe("unverified");
    expect(missing?.detail).toMatch(/not after it/);
  });

  it("withdraws a verified verdict when the developer's tree moved under the run", () => {
    const verified = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: OK_SCOPE,
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(verified.verdict).toBe("verified");

    const detail = sourceDriftDetail({
      digestBefore: "a".repeat(64),
      digestAfter: "b".repeat(64),
      commitBefore: "1111111",
      commitAfter: "2222222",
      dirtyBefore: false,
      dirtyAfter: true,
    });
    expect(detail).toContain("its files changed");
    expect(detail).toContain("HEAD moved from 1111111 to 2222222");

    const withdrawn = invalidateForSourceDrift(verified, detail);
    expect(withdrawn.verdict).toBe("unverified");
    expect(withdrawn.reasons[0]).toBe(detail);
    expect(withdrawn.regressions.some((check) => check.kind === "source" && check.status === "unverified")).toBe(true);
    // The measurements are evidence and are never rewritten by the withdrawal.
    expect(withdrawn.before).toEqual(verified.before);
    expect(withdrawn.after).toEqual(verified.after);
    expect(withdrawn.targets).toEqual(verified.targets);

    // Withdrawing twice does not stack a second source check.
    const twice = invalidateForSourceDrift(withdrawn, detail);
    expect(twice.regressions.filter((check) => check.kind === "source")).toHaveLength(1);
  });

  it("rejects a scope violation even if every measurement looks good", () => {
    const result = verifyRepair({
      targetIssues: [TARGET],
      targetRoutePath: "/support",
      before,
      after: fixed,
      scope: { ok: false, files: ["package.json"], violations: [{ path: "package.json", reason: "dependency manifest" }] },
      build: [command("build"), command("test")],
      overflowLimitPx: 1,
    });
    expect(result.verdict).toBe("rejected");
    expect(result.reasons[0]).toMatch(/outside the approved scope/);
  });
});
