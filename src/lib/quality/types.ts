import type { AccessibilitySnapshot, RunSource, ViewportPreset } from "@/lib/compare/types";

export type { AccessibilitySnapshot };

/**
 * Domain types for the accessibility and responsive-layout checks.
 *
 * Kept free of runtime dependencies for the same reason `compare/types.ts` is: the
 * dashboard renders these objects, so they cross the server/client boundary unchanged.
 *
 * Two rules govern everything here, both from the phase brief:
 *
 *  · **No invented numbers.** There is no accessibility score. A finding is a rule that
 *    fired on a specific element, with the evidence the rule produced — its description,
 *    the element's selector and markup, and the runner's own remediation text. Nothing is
 *    summarised into a figure that would hide what was actually measured.
 *  · **Automated checks are not certification.** What a scan proves is that this rule set
 *    found nothing on this page in this browser at this moment. `status: "needs-review"`
 *    exists for exactly that reason: axe reports results it could not decide (contrast it
 *    cannot compute, for instance) and those are surfaced as questions, never as failures.
 */

/** axe's own severity vocabulary. `null` is axe declining to state one. */
export type AxeImpact = "minor" | "moderate" | "serious" | "critical";

/** Impacts from least to most severe — the order a policy threshold is compared in. */
export const IMPACT_ORDER = ["minor", "moderate", "serious", "critical"] as const;

/**
 * `violation` — the rule failed. `needs-review` — the rule could not decide and a human
 * has to look. Only violations are ever counted against a policy.
 */
export type QualityFindingStatus = "violation" | "needs-review";

export interface AccessibilityFinding {
  /** The axe rule id, e.g. `button-name`. */
  readonly rule: string;
  /** Stated impact, or `null` when the runner declines to judge. */
  readonly impact: AxeImpact | null;
  readonly status: QualityFindingStatus;
  /** What the rule checks, in the runner's words. */
  readonly description: string;
  readonly help: string;
  /** Documentation link for the rule. */
  readonly helpUrl: string;
  /** WCAG tags the rule carries (`wcag2a`, `wcag412`, …). Empty for best-practice rules. */
  readonly wcagTags: readonly string[];
  /** CSS selector of the offending element, as the runner identified it. */
  readonly selector: string;
  /** The element's markup, truncated, so a reviewer can see what was flagged. */
  readonly html: string;
  /** The runner's remediation text for this element, or an empty string. */
  readonly summary: string;
  /**
   * Stable identity of a finding: `<rule>@<selector>`. Two scans of the same rule on the
   * same element produce the same fingerprint, which is what makes "new since the approved
   * baseline" a comparison of evidence rather than of counts.
   */
  readonly fingerprint: string;
}

export interface AccessibilityRunnerInfo {
  readonly name: "axe-core";
  readonly version: string;
  /** Rules that ran and were not inapplicable — reported so a scan cannot claim more. */
  readonly rulesEvaluated: number;
  /** Rule sets requested: `wcag2a`, `wcag21aa`, `best-practice`, … */
  readonly ruleSets: readonly string[];
  /**
   * Node-level results the runner produced across passes, violations and incomplete
   * checks. It is a measure of how much work the scan actually did — not a score, and not
   * a count of distinct elements, which the runner does not report.
   */
  readonly nodeResults: number;
}

export interface AccessibilitySummary {
  readonly runner: AccessibilityRunnerInfo;
  /** Violations per impact. `unknown` collects findings whose impact was not stated. */
  readonly counts: Readonly<Record<AxeImpact | "unknown", number>>;
  /** Findings the runner could not decide. Reported, never counted as failures. */
  readonly needsReview: number;
  /** Violations whose rule carries no WCAG tag (best-practice only). */
  readonly bestPracticeViolations: number;
  readonly findings: readonly AccessibilityFinding[];
  /** True when the finding list was capped; `totalFindings` still holds the full count. */
  readonly truncated: boolean;
  readonly totalFindings: number;
  /**
   * Results the harness refused to read because the runner's payload was not the shape it
   * promises. Non-zero means part of the scan is missing from this report — it is reported
   * rather than swallowed so a suspiciously clean result can be questioned.
   */
  readonly skippedResults: number;
}

export type ResponsiveFindingKind = "document-overflow" | "element-overflow";

export interface ElementRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ResponsiveFinding {
  readonly kind: ResponsiveFindingKind;
  readonly viewportId: string;
  readonly viewportWidth: number;
  readonly selector: string;
  /** Pixels the element (or the document) extends past the viewport edge. */
  readonly overflowPx: number;
  readonly rect: ElementRect;
  /**
   * True when a deliberately scrollable ancestor (`overflow-x: auto|scroll` that actually
   * scrolls) absorbs the overflow. Those are recorded as context and never as defects:
   * a horizontally scrollable table is a design decision, not a layout bug.
   */
  readonly containedInScroller: boolean;
  /** Selector of that scroll container, when there is one. */
  readonly scrollContainer: string | null;
  readonly html: string;
}

export interface ResponsiveSummary {
  readonly viewportId: string;
  readonly viewportWidth: number;
  /** How far the document itself scrolls horizontally, in pixels. */
  readonly documentOverflowPx: number;
  /** Deliberate horizontal scrollers found on the page, whether or not they overflow. */
  readonly scrollableRegions: readonly string[];
  /** Defects: overflow nobody absorbed. */
  readonly findings: readonly ResponsiveFinding[];
  /** Overflow inside a deliberate scroller — evidence, not a defect. */
  readonly contained: readonly ResponsiveFinding[];
  readonly truncated: boolean;
  readonly elementsMeasured: number;
}

/**
 * The deterministic pass/fail policy. Every field is a threshold a reviewer can read and
 * disagree with; nothing here is inferred from the page.
 */
export interface QualityPolicy {
  /** Lowest impact that fails the check. `none` reports everything and fails nothing. */
  readonly failOn: AxeImpact | "none";
  /** Count best-practice violations (rules with no WCAG tag) towards the policy. */
  readonly includeBestPractice: boolean;
  /**
   * Fail only on findings that are not in the approved baseline's snapshot. Needs a
   * trustworthy prior reference; without one the check says so and uses all findings.
   */
  readonly failOnNewOnly: boolean;
  /** Maximum allowed document-level horizontal overflow, in pixels. */
  readonly maxDocumentOverflowPx: number;
  /** Maximum allowed overflow for an element that escapes the viewport, in pixels. */
  readonly maxElementOverflowPx: number;
}

export interface QualityFailure {
  readonly kind: "accessibility" | "responsive";
  /** Machine-readable reason, e.g. `accessibility.serious`, `responsive.document-overflow`. */
  readonly code: string;
  /** The measured reason, in words, with the numbers that produced it. */
  readonly message: string;
  /** How many findings this failure covers. */
  readonly count: number;
  /** Fingerprints (accessibility) or selectors (responsive) behind the count. */
  readonly evidence: readonly string[];
}

export interface QualityVerdict {
  /**
   * `not-evaluated` is the honest answer when no scan ran — a report from a plain visual
   * check has no quality verdict, and saying `pass` there would be a fabricated result.
   */
  readonly status: "pass" | "fail" | "not-evaluated";
  readonly failures: readonly QualityFailure[];
  /**
   * Statements about the verdict itself: a policy that could not be applied as written, or
   * a check that was switched off. Printed next to the verdict so a pass is never more
   * confident than it deserves to be.
   */
  readonly notes: readonly string[];
}

/**
 * The accessibility snapshot of one approved baseline version. `viewportId` is part of the
 * identity because baselines are approved per viewport; an audit at three sizes may draw on
 * up to three references, and the report lists exactly which ones it used.
 */
export interface QualityReference {
  readonly viewportId: string;
  readonly versionId: string;
  readonly approvedAt: string;
  readonly runnerVersion: string;
  readonly fingerprints: readonly string[];
  readonly violationCount: number;
}

export interface QualityScreenshot {
  /** Application-relative URL, so the dashboard can render the evidence. */
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** What one viewport produced: the screenshot plus both measurements of it. */
export interface QualityViewportReport {
  readonly viewport: ViewportPreset;
  readonly accessibility: AccessibilitySummary;
  readonly responsive: ResponsiveSummary;
  readonly screenshot: QualityScreenshot;
  readonly captureMs: number;
  readonly scanMs: number;
}

/** One accessibility audit: measurements, policy, verdict and the evidence files. */
export interface QualityReport {
  readonly id: string;
  readonly createdAt: string;
  readonly policy: QualityPolicy;
  readonly verdict: QualityVerdict;
  /** Which project route, and where, this audit looked at. */
  readonly source: RunSource;
  readonly viewports: readonly QualityViewportReport[];
  /**
   * The approved baselines' accessibility snapshots, one per audited viewport that has one.
   * Empty means the store cannot say which findings are new — the report states that
   * instead of guessing.
   */
  readonly references: readonly QualityReference[];
  /** Violations present now and in no reference. Empty when no reference exists. */
  readonly newFindingFingerprints: readonly string[];
  readonly knownFindingFingerprints: readonly string[];
  /** In a reference and no longer present — the fixes a run can point at. */
  readonly resolvedFindingFingerprints: readonly string[];
  readonly engine: {
    readonly axeVersion: string;
    readonly ruleSets: readonly string[];
    readonly browser: string;
    readonly totalMs: number;
  };
}

/**
 * The quality result of a single page — what a comparison report attaches next to its
 * visual metrics. Same measurements, same policy, same reference semantics as an audit;
 * only the number of viewports differs.
 */
export interface QualitySection {
  readonly policy: QualityPolicy;
  readonly verdict: QualityVerdict;
  readonly accessibility: AccessibilitySummary;
  readonly responsive: ResponsiveSummary;
  readonly references: readonly QualityReference[];
  readonly newFindingFingerprints: readonly string[];
  readonly knownFindingFingerprints: readonly string[];
  readonly resolvedFindingFingerprints: readonly string[];
}

/* ── API envelopes ────────────────────────────────────────────────────────── */

/** One entry of the audit history: enough for a list row, never the whole report. */
export interface AuditSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly status: "pass" | "fail" | "not-evaluated";
  readonly scopeKey: string;
  readonly label: string;
  readonly viewportIds: readonly string[];
  /** Violations per impact across every audited viewport. */
  readonly counts: QualityReport["viewports"][number]["accessibility"]["counts"];
  readonly totalFindings: number;
  readonly needsReview: number;
  readonly responsiveFindings: number;
  readonly newFindings: number;
}

/** `GET /api/audits` — newest-first audit history. */
export interface AuditsResponse {
  readonly audits: readonly AuditSummary[];
}

/** `GET /api/audits/:auditId` — one stored audit. */
export interface AuditResponse {
  readonly report: QualityReport;
}

/** `POST /api/quality/audit` — run one accessibility and layout audit. */
export interface RunAuditRequest {
  /** Phase 3 spelling of the source: `{ kind, projectId, routeId }`. */
  readonly source?: unknown;
  /** Phase 1/2 spelling of a demo target. */
  readonly targetId?: unknown;
  readonly variantId?: unknown;
  /** Viewport preset ids to audit. Absent means every preset (desktop, tablet, mobile). */
  readonly viewports?: unknown;
  /** Policy overrides; absent means the documented defaults. */
  readonly policy?: unknown;
}

export interface RunAuditResponse {
  readonly report: QualityReport;
  /** Absolute path of the persisted `audit.json`, or `null` when the audit was not persisted. */
  readonly reportPath: string | null;
}
