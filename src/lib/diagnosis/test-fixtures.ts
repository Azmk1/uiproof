import type { ComparisonReport, RunSource, ViewportPreset } from "@/lib/compare/types";
import type {
  AccessibilityFinding,
  AccessibilitySummary,
  QualityPolicy,
  QualityReport,
  QualityViewportReport,
  ResponsiveFinding,
  ResponsiveSummary,
} from "@/lib/quality/types";

/**
 * Report fixtures for the diagnosis tests.
 *
 * They are built to look like reports this repository actually writes — the same shapes the
 * `e2e/quality.test.ts` suite produces from a real capture — so the tests exercise the real
 * code paths rather than a convenient invention. Only the tests import this file.
 */

export const VIEWPORTS: Readonly<Record<string, ViewportPreset>> = {
  desktop: { id: "desktop", label: "Desktop", width: 1280, height: 800, deviceScaleFactor: 1 },
  tablet: { id: "tablet", label: "Tablet", width: 834, height: 1112, deviceScaleFactor: 1 },
  mobile: { id: "mobile", label: "Mobile", width: 390, height: 844, deviceScaleFactor: 1 },
};

export const POLICY: QualityPolicy = {
  failOn: "serious",
  includeBestPractice: true,
  failOnNewOnly: false,
  maxDocumentOverflowPx: 1,
  maxElementOverflowPx: 1,
};

export function accessibility(overrides: Partial<AccessibilitySummary> = {}): AccessibilitySummary {
  const findings = overrides.findings ?? [];
  return {
    runner: {
      name: "axe-core",
      version: "4.14.0",
      rulesEvaluated: 41,
      ruleSets: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
      nodeResults: 812,
    },
    counts: { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 },
    needsReview: 0,
    bestPracticeViolations: 0,
    findings,
    violations: [],
    truncated: false,
    totalFindings: findings.length,
    skippedResults: 0,
    ...overrides,
  };
}

export function finding(overrides: Partial<AccessibilityFinding> = {}): AccessibilityFinding {
  const rule = overrides.rule ?? "select-name";
  const selector = overrides.selector ?? "#booking-status";
  return {
    rule,
    impact: "critical",
    status: "violation",
    description: "Select elements must have an accessible name",
    help: "Ensures select element has an accessible name",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/select-name",
    wcagTags: ["wcag2a", "wcag412"],
    selector,
    html: '<select class="input" id="booking-status" name="status"><option value="all">All statuses</option></select>',
    summary: "Fix any of the following: Element does not have an implicit (wrapped) <label>",
    fingerprint: `${rule}@${selector}`,
    ...overrides,
  };
}

export function responsive(overrides: Partial<ResponsiveSummary> = {}): ResponsiveSummary {
  const findings = overrides.findings ?? [];
  return {
    viewportId: "mobile",
    viewportWidth: 390,
    documentOverflowPx: 0,
    scrollableRegions: [],
    findings,
    defects: findings.map((entry) => ({ selector: entry.selector, overflowPx: entry.overflowPx })),
    contained: [],
    truncated: false,
    elementsMeasured: 128,
    ...overrides,
  };
}

export function responsiveFinding(overrides: Partial<ResponsiveFinding> = {}): ResponsiveFinding {
  return {
    kind: "element-overflow",
    viewportId: "mobile",
    viewportWidth: 390,
    selector: "div.promo",
    overflowPx: 348,
    rect: { x: 0, y: 120, width: 720, height: 44 },
    containedInScroller: false,
    scrollContainer: null,
    html: '<div class="promo">Winter offer: a free tune-up with every seven-day hire.</div>',
    ...overrides,
  };
}

export function source(overrides: Partial<RunSource> = {}): RunSource {
  return {
    kind: "project",
    scopeKey: "project:ridgeway-ops/settings",
    label: "Ridgeway Ops · Settings",
    projectId: "ridgeway-ops",
    projectName: "Ridgeway Ops",
    routeId: "settings",
    routeName: "Settings",
    origin: "http://127.0.0.1:4310",
    path: "/settings",
    blockedRequests: 0,
    ...overrides,
  };
}

export function viewportReport(
  viewportId: keyof typeof VIEWPORTS,
  overrides: Partial<QualityViewportReport> = {},
): QualityViewportReport {
  return {
    viewport: VIEWPORTS[viewportId],
    accessibility: accessibility(),
    responsive: responsive({ viewportId, viewportWidth: VIEWPORTS[viewportId].width }),
    screenshot: {
      url: `/api/audits/audit-51117643-5871-4ebf-b10f-04a6e60cd350/${viewportId}.png`,
      bytes: 31_000,
      width: VIEWPORTS[viewportId].width,
      height: VIEWPORTS[viewportId].height,
    },
    captureMs: 900,
    scanMs: 300,
    ...overrides,
  };
}

/** A failing audit of one page: a critical violation plus a mobile layout defect. */
export function auditReport(overrides: Partial<QualityReport> = {}): QualityReport {
  const violation = finding();
  const reviewFinding = finding({
    rule: "color-contrast",
    impact: "serious",
    status: "needs-review",
    selector: "a[href$=\"settings\"]",
    html: '<a class="nav-link" href="/settings">Settings</a>',
    fingerprint: 'color-contrast@a[href$="settings"]',
    wcagTags: ["wcag2aa"],
    summary: "Fix any of the following: Element's background color could not be determined",
  });

  return {
    id: "audit-51117643-5871-4ebf-b10f-04a6e60cd350",
    createdAt: "2026-10-17T19:39:55.000Z",
    policy: POLICY,
    verdict: {
      status: "fail",
      failures: [
        {
          kind: "accessibility",
          code: "accessibility.critical",
          message: '1 accessibility violation at impact "critical" meets the "serious" threshold (rule@selector): select-name@#booking-status',
          count: 1,
          evidence: ["select-name@#booking-status"],
        },
        {
          kind: "responsive",
          code: "responsive.document-overflow",
          message: "the document scrolls 348px horizontally at mobile (viewport 390px, limit 1px)",
          count: 1,
          evidence: ["div.promo"],
        },
      ],
      notes: [],
    },
    source: source({ scopeKey: "project:ridgeway-ops/settings", label: "Ridgeway Ops · Settings", routeId: "settings", path: "/settings" }),
    viewports: [
      viewportReport("desktop"),
      viewportReport("tablet"),
      viewportReport("mobile", {
        accessibility: accessibility({ counts: { minor: 0, moderate: 0, serious: 0, critical: 1, unknown: 0 }, findings: [violation, reviewFinding], needsReview: 1, totalFindings: 2 }),
        responsive: responsive({
          viewportId: "mobile",
          viewportWidth: 390,
          documentOverflowPx: 348,
          findings: [responsiveFinding()],
          contained: [responsiveFinding({ selector: "table.table", overflowPx: 154, containedInScroller: true, scrollContainer: "div.table-wrap" })],
          scrollableRegions: ["div.table-wrap"],
        }),
      }),
    ],
    references: [],
    newFindingFingerprints: [],
    knownFindingFingerprints: [],
    resolvedFindingFingerprints: [],
    engine: {
      axeVersion: "4.14.0",
      ruleSets: ["wcag2a", "wcag2aa", "best-practice"],
      browser: "chromium 1.64.1",
      totalMs: 3421,
    },
    ...overrides,
  };
}

/** A visual regression on the same page, optionally with a quality section attached. */
export function comparisonReport(overrides: Partial<ComparisonReport> = {}): ComparisonReport {
  return {
    id: "run-232b4b94-b7c4-4575-b040-52cf4a7e7f1d",
    createdAt: "2026-10-17T19:36:00.000Z",
    status: "regression",
    mode: "baseline",
    variantId: null,
    baseline: {
      versionId: "bl-ea1d8061-42d3-451b-b6de-6567579ee941",
      approvedAt: "2026-10-17T19:34:55.000Z",
      sourceReportId: "run-24582201-0bd9-4eb2-84b2-edfcbff0e7ab",
      capturedRoute: "/settings",
      origin: "http://127.0.0.1:4310",
      width: 1280,
      height: 800,
      imageUrl:
        "/api/baselines/projects/ridgeway-ops/settings/desktop/bl-ea1d8061-42d3-451b-b6de-6567579ee941.png",
    },
    source: source(),
    target: {
      id: "ridgeway-ops",
      label: "Ridgeway Ops · Settings",
      baselinePath: "/settings",
      currentPath: "/settings",
    },
    viewport: VIEWPORTS.desktop,
    metrics: {
      changedPixels: 54_686,
      comparedPixels: 1_024_000,
      changePercentage: 5.3404,
      pixelThreshold: 0.1,
      maxDiffPercent: 0.1,
      dimensionsChanged: false,
    },
    artifacts: {
      current: { url: "/api/artifacts/run-232b4b94-b7c4-4575-b040-52cf4a7e7f1d/current.png", bytes: 77_170, width: 1280, height: 800 },
      diff: { url: "/api/artifacts/run-232b4b94-b7c4-4575-b040-52cf4a7e7f1d/diff.png", bytes: 132_867, width: 1280, height: 800 },
    },
    engine: {
      provider: "playwright",
      comparator: "pixelmatch",
      browser: "chromium 1.64.1",
      captureMs: 986,
      compareMs: 210,
      totalMs: 1696,
    },
    ...overrides,
  };
}
