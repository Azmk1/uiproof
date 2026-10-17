import { describe, expect, it } from "vitest";
import type { ViewportPreset } from "@/lib/compare/types";
import { DEFAULT_QUALITY_POLICY } from "./policy";
import {
  groupFindingsByImpact,
  qualityModelFromReport,
  qualityModelFromSection,
  type QualityPanelEntry,
} from "./presentation";
import type {
  AccessibilityFinding,
  AccessibilitySummary,
  QualityReport,
  QualitySection,
  ResponsiveSummary,
} from "./types";

function finding(overrides: Partial<AccessibilityFinding> = {}): AccessibilityFinding {
  return {
    rule: "button-name",
    impact: "critical",
    status: "violation",
    description: "Ensures buttons have discernible text",
    help: "Buttons must have discernible text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.8/button-name",
    wcagTags: ["wcag2a", "wcag412"],
    selector: "button#save",
    html: "<button id=\"save\"></button>",
    summary: "Element does not have inner text",
    fingerprint: "button-name@button#save",
    ...overrides,
  };
}

function accessibility(findings: readonly AccessibilityFinding[]): AccessibilitySummary {
  return {
    runner: {
      name: "axe-core",
      version: "4.10.2",
      rulesEvaluated: 42,
      ruleSets: ["wcag2a", "wcag21aa"],
      nodeResults: 7,
    },
    counts: {
      minor: findings.filter((item) => item.impact === "minor").length,
      moderate: findings.filter((item) => item.impact === "moderate").length,
      serious: findings.filter((item) => item.impact === "serious").length,
      critical: findings.filter((item) => item.impact === "critical").length,
      unknown: findings.filter((item) => item.impact === null).length,
    },
    needsReview: findings.filter((item) => item.status === "needs-review").length,
    bestPracticeViolations: 0,
    findings,
    truncated: false,
    totalFindings: findings.length,
    skippedResults: 0,
  };
}

function responsive(): ResponsiveSummary {
  return {
    viewportId: "desktop",
    viewportWidth: 1280,
    documentOverflowPx: 0,
    scrollableRegions: [],
    findings: [],
    contained: [],
    truncated: false,
    elementsMeasured: 120,
  };
}

const desktop: ViewportPreset = { id: "desktop", label: "Desktop", width: 1280, height: 800, deviceScaleFactor: 1 };
const mobile: ViewportPreset = { id: "mobile", label: "Mobile", width: 390, height: 844, deviceScaleFactor: 2 };

function entry(viewport: ViewportPreset, findings: readonly AccessibilityFinding[]): QualityPanelEntry {
  return { viewport, accessibility: accessibility(findings), responsive: responsive(), screenshot: null };
}

describe("groupFindingsByImpact", () => {
  it("orders violation groups most severe first and omits empty impacts", () => {
    const grouped = groupFindingsByImpact([
      entry(desktop, [
        finding({ impact: "minor", rule: "region", fingerprint: "region@body", selector: "body" }),
        finding(),
        finding({ impact: "moderate", rule: "label", fingerprint: "label@input", selector: "input" }),
      ]),
    ]);

    expect(grouped.violations.map((group) => group.impact)).toEqual(["critical", "moderate", "minor"]);
    expect(grouped.review).toEqual([]);
  });

  it("deduplicates a finding seen at several viewports and records where it appeared", () => {
    const shared = finding();
    const mobileOnly = finding({
      impact: "serious",
      rule: "color-contrast",
      fingerprint: "color-contrast@p.lead",
      selector: "p.lead",
    });
    const grouped = groupFindingsByImpact([
      entry(desktop, [shared]),
      entry(mobile, [shared, mobileOnly]),
    ]);

    const critical = grouped.violations.find((group) => group.impact === "critical");
    expect(critical?.rows).toHaveLength(1);
    expect(critical?.rows[0].viewportIds).toEqual(["desktop", "mobile"]);

    const serious = grouped.violations.find((group) => group.impact === "serious");
    expect(serious?.rows[0].viewportIds).toEqual(["mobile"]);
  });

  it("keeps needs-review results apart from violations, whatever their impact says", () => {
    const grouped = groupFindingsByImpact([
      entry(desktop, [finding({ status: "needs-review", impact: "critical" })]),
    ]);

    expect(grouped.violations).toEqual([]);
    expect(grouped.review).toHaveLength(1);
    expect(grouped.review[0].finding.status).toBe("needs-review");
  });

  it("collects findings with no stated impact in an unknown group, ordered last", () => {
    const grouped = groupFindingsByImpact([
      entry(desktop, [finding({ impact: null, fingerprint: "unknown@div" }), finding({ impact: "minor" })]),
    ]);

    expect(grouped.violations.map((group) => group.impact)).toEqual(["minor", "unknown"]);
  });
});

describe("qualityModelFromReport", () => {
  const report: QualityReport = {
    id: "audit-8f14e45f",
    createdAt: "2026-10-16T10:00:00.000Z",
    policy: DEFAULT_QUALITY_POLICY,
    verdict: { status: "pass", failures: [], notes: [] },
    source: {
      kind: "project",
      scopeKey: "project:example/quality",
      label: "Example · Quality",
      projectId: "example",
      projectName: "Example",
      routeId: "quality",
      routeName: "Quality",
      origin: "http://127.0.0.1:5321",
      path: "/quality",
      blockedRequests: 0,
    },
    viewports: [
      {
        viewport: desktop,
        accessibility: accessibility([finding()]),
        responsive: responsive(),
        screenshot: { url: "/api/audits/audit-8f14e45f/desktop.png", bytes: 4096, width: 1280, height: 800 },
        captureMs: 210,
        scanMs: 95,
      },
    ],
    references: [
      {
        viewportId: "desktop",
        versionId: "bl-1",
        approvedAt: "2026-10-15T09:00:00.000Z",
        runnerVersion: "4.10.2",
        fingerprints: [],
        violationCount: 0,
      },
    ],
    newFindingFingerprints: ["button-name@button#save"],
    knownFindingFingerprints: [],
    resolvedFindingFingerprints: ["label@input"],
    engine: { axeVersion: "4.10.2", ruleSets: ["wcag2a", "wcag21aa"], browser: "chromium", totalMs: 1450 },
  };

  it("carries measurements, evidence and engine facts into the panel model unchanged", () => {
    const model = qualityModelFromReport(report);

    expect(model.id).toBe(report.id);
    expect(model.createdAt).toBe(report.createdAt);
    expect(model.verdict).toBe(report.verdict);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].viewport).toBe(desktop);
    expect(model.entries[0].screenshot).toEqual({
      url: "/api/audits/audit-8f14e45f/desktop.png",
      bytes: 4096,
      width: 1280,
      height: 800,
    });
    expect(model.references).toBe(report.references);
    expect(model.newFindingFingerprints).toEqual(["button-name@button#save"]);
    expect(model.resolvedFindingFingerprints).toEqual(["label@input"]);
    expect(model.engine).toEqual({
      axeVersion: "4.10.2",
      ruleSets: ["wcag2a", "wcag21aa"],
      browser: "chromium",
      totalMs: 1450,
    });
  });
});

describe("qualityModelFromSection", () => {
  const section: QualitySection = {
    policy: DEFAULT_QUALITY_POLICY,
    verdict: { status: "fail", failures: [], notes: ["x"] },
    accessibility: accessibility([finding()]),
    responsive: responsive(),
    references: [],
    newFindingFingerprints: [],
    knownFindingFingerprints: ["button-name@button#save"],
    resolvedFindingFingerprints: [],
  };

  it("models a single viewport and keeps the report unattributed to an audit", () => {
    const model = qualityModelFromSection(section, mobile, {
      url: "/api/artifacts/run-1/current.png",
      bytes: 1024,
      width: 390,
      height: 844,
    });

    expect(model.id).toBeNull();
    expect(model.createdAt).toBeNull();
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].viewport).toBe(mobile);
    expect(model.entries[0].screenshot?.url).toBe("/api/artifacts/run-1/current.png");
    expect(model.engine).toEqual({ axeVersion: "4.10.2", ruleSets: ["wcag2a", "wcag21aa"], browser: null, totalMs: null });
    expect(model.knownFindingFingerprints).toEqual(["button-name@button#save"]);
  });
});
