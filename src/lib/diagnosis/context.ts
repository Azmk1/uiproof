import { ComparisonError } from "@/lib/compare/errors";
import { formatChangePercentage } from "@/lib/compare/metrics";
import type { ComparisonReport } from "@/lib/compare/types";
import type { AccessibilityFinding, QualityReport } from "@/lib/quality/types";
import type { DiagnosticEvidence, DiagnosticIssue, MeasuredFact } from "./types";

/**
 * Turns a stored report into the issues worth explaining.
 *
 * This module is the boundary between **measurement** and **interpretation**, and it only
 * ever produces the first: every fact below is copied out of a report UIProof wrote from a
 * real capture and a real scan, and every piece of evidence is a path into the artifacts
 * that report produced. Nothing here asks a model anything, guesses at a cause, or reads
 * application source — the investigation happens next, on top of this.
 *
 * A diagnosis is refused when there is nothing measured to explain. That is a refusal, not
 * an empty diagnosis: "no regressions found, so here is a story about your code" is exactly
 * the failure mode this phase exists to avoid.
 */

/** Facts are strings so the same value can be shown, prompted and stored unchanged. */
function fact(label: string, value: string | number | boolean | null | undefined): MeasuredFact | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  return { label, value: typeof value === "string" ? value : String(value) };
}

function facts(entries: readonly (MeasuredFact | null)[]): MeasuredFact[] {
  return entries.filter((entry): entry is MeasuredFact => entry !== null);
}

/** Normalises a fingerprint into a key an LLM can echo back verbatim. */
function fingerprintKey(prefix: string, identity: string): string {
  return `${prefix}:${identity.replace(/\s+/g, " ").trim()}`;
}

function accessibilityIssue(finding: AccessibilityFinding, viewportIds: readonly string[]): DiagnosticIssue {
  return {
    key: fingerprintKey("a11y", finding.fingerprint),
    kind: "accessibility",
    title: `${finding.rule} on ${finding.selector}`,
    impact: finding.impact,
    measured: facts([
      fact("Rule", finding.rule),
      fact("Impact", finding.impact ?? "unstated by the runner"),
      fact("WCAG tags", finding.wcagTags.length > 0 ? finding.wcagTags.join(", ") : "none (best-practice rule)"),
      fact("Selector", finding.selector),
      fact("Element", finding.html),
      fact("Runner summary", finding.summary),
      fact("Measured at viewport(s)", viewportIds.join(", ")),
    ]),
    hints: { selector: finding.selector, html: finding.html },
    evidence: [
      {
        kind: "finding",
        url: null,
        note: `axe-core reported ${finding.fingerprint} — see the audit report for the full rule text.`,
      },
      ...(finding.helpUrl.length > 0
        ? [{ kind: "report" as const, url: finding.helpUrl, note: `Runner documentation for ${finding.rule}.` }]
        : []),
    ],
  };
}

/** Screenshot evidence for one audited viewport, when the audit stored one. */
function auditScreenshotEvidence(report: QualityReport, viewportIds: readonly string[]): DiagnosticEvidence[] {
  return report.viewports
    .filter((entry) => viewportIds.includes(entry.viewport.id))
    .map((entry) => ({
      kind: "screenshot" as const,
      url: entry.screenshot.url,
      note: `The ${entry.viewport.label} screenshot this measurement came from (${entry.viewport.width}×${entry.viewport.height}).`,
    }));
}

/**
 * Accessibility violations and layout defects from a multi-viewport audit.
 *
 * Only **violations** become issues. `needs-review` results are questions for a human and
 * are deliberately not handed to a model as if they were defects — the count is reported
 * as a warning instead, so a reader knows the diagnosis did not cover them.
 */
export function issuesFromQualityReport(report: QualityReport): { issues: DiagnosticIssue[]; warnings: string[] } {
  const warnings: string[] = [];
  const issues: DiagnosticIssue[] = [];
  const seen = new Set<string>();

  // Accessibility: one issue per fingerprint, with every viewport it was measured at.
  const byFingerprint = new Map<string, { finding: AccessibilityFinding; viewportIds: string[] }>();
  for (const entry of report.viewports) {
    for (const finding of entry.accessibility.findings) {
      if (finding.status !== "violation") continue;
      const existing = byFingerprint.get(finding.fingerprint);
      if (existing) {
        if (!existing.viewportIds.includes(entry.viewport.id)) existing.viewportIds.push(entry.viewport.id);
      } else {
        byFingerprint.set(finding.fingerprint, { finding, viewportIds: [entry.viewport.id] });
      }
    }
  }

  for (const { finding, viewportIds } of byFingerprint.values()) {
    const issue = accessibilityIssue(finding, viewportIds);
    issues.push({ ...issue, evidence: [...issue.evidence, ...auditScreenshotEvidence(report, viewportIds)] });
    seen.add(issue.key);
  }

  // Layout: one issue per viewport, carrying the document overflow and every escaping
  // element. A deliberate scroller is not a defect and is not offered as one.
  for (const entry of report.viewports) {
    const { responsive, viewport } = entry;
    if (responsive.documentOverflowPx <= report.policy.maxDocumentOverflowPx && responsive.findings.length === 0) {
      continue;
    }
    const defectSelectors = responsive.defects.map((defect) => `${defect.selector} (+${defect.overflowPx}px)`);
    issues.push({
      key: fingerprintKey("responsive", viewport.id),
      kind: "responsive",
      title: `Horizontal overflow at ${viewport.label}`,
      measured: facts([
        fact("Viewport", `${viewport.label} (${viewport.width}px wide)`),
        fact("Document overflow", `${responsive.documentOverflowPx}px (limit ${report.policy.maxDocumentOverflowPx}px)`),
        fact("Elements escaping the viewport", responsive.defects.length),
        fact("Escaping elements", defectSelectors.join(", ")),
        fact("Elements measured", responsive.elementsMeasured),
        fact(
          "Deliberate horizontal scrollers on the page",
          responsive.scrollableRegions.length > 0 ? responsive.scrollableRegions.join(", ") : "none",
        ),
      ]),
      hints: {
        selector: responsive.findings[0]?.selector ?? responsive.defects[0]?.selector,
        html: responsive.findings[0]?.html ?? "",
      },
      evidence: [
        ...auditScreenshotEvidence(report, [viewport.id]),
        {
          kind: "reference",
          url: null,
          note: "Overflow inside a deliberate scroller is recorded as contained evidence, not as a defect.",
        },
      ],
    });
  }

  const needsReview = report.viewports.reduce((total, entry) => total + entry.accessibility.needsReview, 0);
  if (needsReview > 0) {
    warnings.push(
      `${needsReview} needs-review result(s) were not diagnosed: the runner could not decide them, so they are questions rather than defects.`,
    );
  }
  if (report.references.length === 0) {
    warnings.push(
      "This audit had no approved accessibility reference, so it cannot say which findings are new — the diagnosis covers everything it measured.",
    );
  }

  return { issues, warnings };
}

/**
 * Issues from a comparison report: a visual regression, plus the quality section when the
 * run measured one. A run that passed or only captured has nothing to diagnose.
 */
export function issuesFromComparisonReport(report: ComparisonReport): { issues: DiagnosticIssue[]; warnings: string[] } {
  const warnings: string[] = [];
  const issues: DiagnosticIssue[] = [];
  const { metrics, artifacts, viewport, engine } = report;

  if (report.status === "regression") {
    const evidence: DiagnosticEvidence[] = [];
    if (artifacts.diff) {
      evidence.push({
        kind: "diff",
        url: artifacts.diff.url,
        note: `The highlighted difference image: ${metrics.changedPixels.toLocaleString("en-US")} changed pixels.`,
      });
    }
    evidence.push({
      kind: "screenshot",
      url: artifacts.current.url,
      note: "The current capture this comparison measured.",
    });
    if (artifacts.baseline) {
      evidence.push({
        kind: "screenshot",
        url: artifacts.baseline.url,
        note: `The current run's reference side (${report.target.baselinePath}).`,
      });
    }
    if (report.baseline) {
      evidence.push({
        kind: "reference",
        url: null,
        note: `Compared against approved baseline ${report.baseline.versionId}, approved ${report.baseline.approvedAt}.`,
      });
    }

    issues.push({
      key: "visual:regression",
      kind: "visual",
      title: `Visual regression on ${report.target.label}`,
      measured: facts([
        fact("Viewport", `${viewport.label} (${viewport.width}×${viewport.height})`),
        fact("Changed pixels", metrics.changedPixels),
        fact("Compared pixels", metrics.comparedPixels),
        fact("Share of the viewport changed", `${formatChangePercentage(metrics.changePercentage, 4)}%`),
        fact("Tolerance", `${metrics.maxDiffPercent}%`),
        fact("Dimensions changed", metrics.dimensionsChanged),
        fact("Route", report.source ? `${report.source.origin}${report.source.path}` : report.target.currentPath),
        fact("Mode", report.mode ?? "fixture"),
        fact("Renderer", `${engine.browser} · pixelmatch, colour threshold ${metrics.pixelThreshold}`),
      ]),
      evidence,
    });
  }

  const section = report.quality;
  if (section) {
    const byFingerprint = new Map<string, AccessibilityFinding>();
    for (const finding of section.accessibility.findings) {
      if (finding.status !== "violation") continue;
      if (!byFingerprint.has(finding.fingerprint)) byFingerprint.set(finding.fingerprint, finding);
    }
    for (const finding of byFingerprint.values()) {
      const issue = accessibilityIssue(finding, [viewport.id]);
      issues.push({
        ...issue,
        evidence: [
          ...issue.evidence,
          {
            kind: "screenshot",
            url: artifacts.current.url,
            note: `The ${viewport.label} screenshot this scan ran in.`,
          },
        ],
      });
    }

    const { responsive } = section;
    if (responsive.documentOverflowPx > section.policy.maxDocumentOverflowPx || responsive.findings.length > 0) {
      issues.push({
        key: fingerprintKey("responsive", viewport.id),
        kind: "responsive",
        title: `Horizontal overflow at ${viewport.label}`,
        measured: facts([
          fact("Viewport", `${viewport.label} (${viewport.width}px wide)`),
          fact("Document overflow", `${responsive.documentOverflowPx}px (limit ${section.policy.maxDocumentOverflowPx}px)`),
          fact("Elements escaping the viewport", responsive.defects.length),
          fact(
            "Escaping elements",
            responsive.defects.map((defect) => `${defect.selector} (+${defect.overflowPx}px)`).join(", "),
          ),
        ]),
        hints: {
          selector: responsive.findings[0]?.selector ?? responsive.defects[0]?.selector,
          html: responsive.findings[0]?.html ?? "",
        },
        evidence: [
          { kind: "screenshot", url: artifacts.current.url, note: "The capture the layout was measured in." },
        ],
      });
    }

    if (section.accessibility.needsReview > 0) {
      warnings.push(
        `${section.accessibility.needsReview} needs-review result(s) were not diagnosed: the runner could not decide them.`,
      );
    }
  }

  if (report.status === "pass") {
    warnings.push("This run passed: there is no regression to explain.");
  }
  if (report.status === "captured") {
    warnings.push("This run only captured a screenshot; nothing was compared, so there is nothing to explain.");
  }

  return { issues, warnings };
}

export interface DiagnosticContext {
  readonly reportId: string | null;
  readonly auditId: string | null;
  readonly scopeKey: string;
  readonly sourceLabel: string;
  /** Route the page was at, when the report names one. */
  readonly route: string | null;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly issues: readonly DiagnosticIssue[];
  readonly warnings: readonly string[];
}

/** The context of a stored audit. */
export function contextFromAudit(report: QualityReport): DiagnosticContext {
  const { issues, warnings } = issuesFromQualityReport(report);
  return {
    reportId: null,
    auditId: report.id,
    scopeKey: report.source.scopeKey,
    sourceLabel: report.source.label,
    route: report.source.path,
    projectId: report.source.projectId,
    createdAt: report.createdAt,
    issues,
    warnings,
  };
}

/** The context of a stored comparison run. */
export function contextFromReport(report: ComparisonReport): DiagnosticContext {
  const { issues, warnings } = issuesFromComparisonReport(report);
  const source = report.source ?? null;
  return {
    reportId: report.id,
    auditId: null,
    scopeKey: source?.scopeKey ?? `demo:${report.target.id}`,
    sourceLabel: source?.label ?? report.target.label,
    route: source?.path ?? report.target.currentPath,
    projectId: source?.projectId ?? null,
    createdAt: report.createdAt,
    issues,
    warnings,
  };
}

/** Refuses a context that has nothing measured to explain. */
export function requireDiagnosable(context: DiagnosticContext, maxIssues: number): DiagnosticIssue[] {
  if (context.issues.length === 0) {
    throw new ComparisonError(
      "diagnosis_nothing_to_diagnose",
      context.warnings.length > 0
        ? `Nothing to diagnose: ${context.warnings.join(" ")}`
        : "Nothing to diagnose: the report contains no regression, violation or layout defect.",
    );
  }
  return [...context.issues].slice(0, maxIssues);
}
