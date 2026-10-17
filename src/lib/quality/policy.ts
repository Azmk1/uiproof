import {
  IMPACT_ORDER,
  type AccessibilitySummary,
  type AxeImpact,
  type QualityFailure,
  type QualityPolicy,
  type QualityReference,
  type QualityVerdict,
  type ResponsiveSummary,
} from "./types";

/**
 * The quality gate's judgement, kept separate from its measurement.
 *
 * Measurement lives in `axe.ts` and `responsive.ts` and only records what a browser
 * produced. Everything in this file turns those measurements into a verdict, using
 * thresholds a reviewer can read, change and disagree with. Nothing here re-measures
 * anything: a policy that could change a number would make the report unfalsifiable.
 *
 * Two decisions are worth naming.
 *
 *  · **A finding with no stated impact is never presumed harmless.** axe can decline to
 *    state an impact. Such a violation is counted against every threshold except `none`,
 *    because placing it below the threshold would be inventing a judgement the runner
 *    withheld. It is reported as its own code (`accessibility.unknown`) so the reason a
 *    gate failed is visible.
 *  · **`failOnNewOnly` without a trustworthy reference counts everything.** The alternative
 *    would be treating unreadable history as an approval, which is how a gate silently stops
 *    failing. The verdict says so in `notes` instead.
 */

export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  failOn: "serious",
  includeBestPractice: true,
  failOnNewOnly: false,
  maxDocumentOverflowPx: 1,
  maxElementOverflowPx: 1,
};

const POLICY_KEYS = [
  "failOn",
  "includeBestPractice",
  "failOnNewOnly",
  "maxDocumentOverflowPx",
  "maxElementOverflowPx",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailOn(value: unknown): AxeImpact | "none" {
  const allowed: readonly string[] = [...IMPACT_ORDER, "none"];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new RangeError(`failOn must be one of: ${allowed.join(", ")}`);
  }
  return value as AxeImpact | "none";
}

function parseBoolean(key: PolicyKey, value: unknown): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${key} must be true or false`);
  return value;
}

function parsePixels(key: PolicyKey, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${key} must be a number of pixels, zero or more`);
  }
  return value;
}

/**
 * Reads a policy from untrusted input (a CLI flag, a JSON body, a configuration file).
 * Unknown keys are refused rather than ignored: a misspelled threshold that silently does
 * nothing is a gate that quietly stops checking.
 */
export function parseQualityPolicy(input: unknown, base: QualityPolicy = DEFAULT_QUALITY_POLICY): QualityPolicy {
  if (input === undefined || input === null) return { ...base };
  if (!isRecord(input)) throw new RangeError("the quality policy must be a JSON object");

  for (const key of Object.keys(input)) {
    if (!(POLICY_KEYS as readonly string[]).includes(key)) {
      throw new RangeError(`unknown quality policy field ${JSON.stringify(key)}`);
    }
  }

  return {
    failOn: input.failOn === undefined ? base.failOn : parseFailOn(input.failOn),
    includeBestPractice:
      input.includeBestPractice === undefined
        ? base.includeBestPractice
        : parseBoolean("includeBestPractice", input.includeBestPractice),
    failOnNewOnly:
      input.failOnNewOnly === undefined ? base.failOnNewOnly : parseBoolean("failOnNewOnly", input.failOnNewOnly),
    maxDocumentOverflowPx:
      input.maxDocumentOverflowPx === undefined
        ? base.maxDocumentOverflowPx
        : parsePixels("maxDocumentOverflowPx", input.maxDocumentOverflowPx),
    maxElementOverflowPx:
      input.maxElementOverflowPx === undefined
        ? base.maxElementOverflowPx
        : parsePixels("maxElementOverflowPx", input.maxElementOverflowPx),
  };
}

/** Rank of an impact for threshold comparison; `null` (unstated) ranks above every band. */
function rank(impact: AxeImpact | null): number {
  return impact === null ? IMPACT_ORDER.length : IMPACT_ORDER.indexOf(impact);
}

const IMPACT_CODES: readonly string[] = [...IMPACT_ORDER, "unknown"];

export interface QualityVerdictInput {
  readonly policy: QualityPolicy;
  /** One entry per audited viewport, in the order they were captured. */
  readonly viewports: readonly {
    readonly viewportId: string;
    readonly accessibility: AccessibilitySummary;
    readonly responsive: ResponsiveSummary;
  }[];
  /**
   * The approved accessibility reference for each viewport that has one. `null` means no
   * approved snapshot exists for any audited viewport. A viewport missing from the map has
   * no reference of its own — an approval for desktop never authorises a finding on mobile,
   * because the two were measured at different sizes and axe can legitimately disagree.
   */
  readonly referencesByViewport: ReadonlyMap<string, QualityReference> | null;
}

export interface QualityVerdictResult {
  readonly verdict: QualityVerdict;
  /** Violation fingerprints present now, sorted. */
  readonly fingerprints: readonly string[];
  /** Violations present now and in no reference. Empty without a reference. */
  readonly newFindingFingerprints: readonly string[];
  readonly knownFindingFingerprints: readonly string[];
  /** In a reference and no longer present — the fixes a run can point at. */
  readonly resolvedFindingFingerprints: readonly string[];
  /** Findings counted against the policy, by fingerprint — the failures' evidence. */
  readonly countedFingerprints: readonly string[];
}

/**
 * Turns measurements into a verdict. Every failure names what was measured, how much of it
 * there was and the evidence behind the count; the same inputs always produce the same
 * verdict and the same order.
 *
 * Everything here reads the *complete* measurement indexes (`violations`, `defects`), never
 * the capped lists the report displays. A reporting limit can hide a finding from a reader;
 * it can never hide one from the verdict.
 *
 * References are matched per viewport. An approved desktop snapshot says nothing about the
 * mobile rendering of the same page, so a finding there is only "known" if the mobile
 * reference — for this scope and this viewport — contains its fingerprint. A viewport with
 * no reference has no approved findings at all: everything measured there is unapproved,
 * and the verdict says so rather than borrowing another viewport's approval.
 */
export function evaluateQualityPolicy(input: QualityVerdictInput): QualityVerdictResult {
  const { policy } = input;
  const notes: string[] = [];
  const references = input.referencesByViewport;

  // fingerprint → the most severe appearance, used for threshold and best-practice filters.
  const appearances = new Map<string, { impact: AxeImpact | null; wcag: boolean }>();
  const present = new Set<string>();
  const fresh = new Set<string>();
  const knownSet = new Set<string>();
  const resolvedSet = new Set<string>();
  const uncovered: string[] = [];
  let anyReference = false;

  for (const viewport of input.viewports) {
    const reference = references?.get(viewport.viewportId) ?? null;
    if (reference) anyReference = true;
    const approved = reference ? new Set(reference.fingerprints) : null;
    const here = new Set<string>();

    if (approved === null) {
      if (!uncovered.includes(viewport.viewportId)) uncovered.push(viewport.viewportId);
    } else if (reference && reference.runnerVersion !== viewport.accessibility.runner.version) {
      notes.push(
        `The approved snapshot for ${viewport.viewportId} was recorded by axe-core ${reference.runnerVersion}, ` +
          `but this scan ran ${viewport.accessibility.runner.version}: new and resolved findings can reflect that change.`,
      );
    }

    for (const violation of viewport.accessibility.violations) {
      const fingerprint = violation.fingerprint;
      here.add(fingerprint);
      present.add(fingerprint);
      const existing = appearances.get(fingerprint);
      if (!existing) {
        appearances.set(fingerprint, { impact: violation.impact, wcag: violation.wcag });
      } else {
        if (rank(violation.impact) > rank(existing.impact)) existing.impact = violation.impact;
        if (violation.wcag) existing.wcag = true;
      }
      if (approved === null || !approved.has(fingerprint)) fresh.add(fingerprint);
      else knownSet.add(fingerprint);
    }

    if (approved !== null) {
      for (const fingerprint of approved) {
        if (!here.has(fingerprint)) resolvedSet.add(fingerprint);
      }
    }
  }

  // A fingerprint approved at one viewport but unapproved at another is unapproved overall.
  for (const fingerprint of fresh) knownSet.delete(fingerprint);

  if (!anyReference) {
    notes.push(
      "No approved baseline records an accessibility snapshot for this scope, so new, known and resolved findings cannot be distinguished — every finding counts as new.",
    );
    if (policy.failOnNewOnly) {
      notes.push(
        "failOnNewOnly is on, but there is no approved baseline to compare against, so every finding counts. Approve a run to establish the reference.",
      );
    }
  } else {
    for (const viewportId of uncovered) {
      notes.push(
        `No approved accessibility snapshot exists for ${viewportId}, so findings measured there are treated as unapproved (new).`,
      );
    }
  }

  for (const viewport of input.viewports) {
    if (viewport.accessibility.truncated) {
      notes.push(
        `${viewport.viewportId}: the report lists ${viewport.accessibility.findings.length} of ` +
          `${viewport.accessibility.totalFindings} findings; the verdict evaluated all ${viewport.accessibility.totalFindings}.`,
      );
    }
    if (viewport.responsive.truncated) {
      notes.push(
        `${viewport.viewportId}: the report lists ${viewport.responsive.findings.length} of ` +
          `${viewport.responsive.defects.length} layout defects; the verdict evaluated all ${viewport.responsive.defects.length}.`,
      );
    }
  }

  const fingerprints = [...present].sort();
  const freshSorted = [...fresh].sort();
  const known = [...knownSet].sort();
  const resolved = [...resolvedSet].sort();
  const counted = policy.failOnNewOnly ? freshSorted : fingerprints;

  const failures: QualityFailure[] = [];

  if (policy.failOn !== "none") {
    const threshold = IMPACT_ORDER.indexOf(policy.failOn);
    const byCode = new Map<string, string[]>();
    for (const fingerprint of counted) {
      const appearance = appearances.get(fingerprint);
      if (!appearance) continue;
      if (!policy.includeBestPractice && !appearance.wcag) continue;
      if (rank(appearance.impact) < threshold) continue;
      const code = `accessibility.${appearance.impact ?? "unknown"}`;
      const bucket = byCode.get(code) ?? [];
      bucket.push(fingerprint);
      byCode.set(code, bucket);
    }

    for (const code of IMPACT_CODES.map((impact) => `accessibility.${impact}`)) {
      const evidence = byCode.get(code);
      if (!evidence || evidence.length === 0) continue;
      const impact = code.slice("accessibility.".length);
      const scope = policy.failOnNewOnly ? "new " : "";
      failures.push({
        kind: "accessibility",
        code,
        message: `${evidence.length} ${scope}accessibility violation${evidence.length === 1 ? "" : "s"} at impact "${impact}" meet the "${policy.failOn}" threshold (rule@selector): ${evidence.join(", ")}`,
        count: evidence.length,
        evidence,
      });
    }
  } else {
    notes.push("failOn is \"none\": accessibility findings are reported but never fail the check.");
  }

  for (const viewport of input.viewports) {
    // The measurement's own viewport id is used here: a failure must name the viewport the
    // overflow was seen at, not the one the caller happened to label the entry with.
    const measuredAt = viewport.responsive.viewportId;
    const documentOverflow = viewport.responsive.documentOverflowPx;
    if (documentOverflow > policy.maxDocumentOverflowPx) {
      failures.push({
        kind: "responsive",
        code: "responsive.document-overflow",
        message: `the document scrolls ${documentOverflow}px horizontally at ${measuredAt} (viewport ${viewport.responsive.viewportWidth}px, limit ${policy.maxDocumentOverflowPx}px)`,
        count: 1,
        evidence: [`viewport:${measuredAt}`],
      });
    }
    const escaped = viewport.responsive.defects.filter(
      (defect) => defect.overflowPx > policy.maxElementOverflowPx,
    );
    if (escaped.length > 0) {
      failures.push({
        kind: "responsive",
        code: "responsive.element-overflow",
        message: `${escaped.length} element${escaped.length === 1 ? "" : "s"} escape${escaped.length === 1 ? "s" : ""} the ${measuredAt} viewport (limit ${policy.maxElementOverflowPx}px): ${escaped.map((defect) => `${defect.selector} +${defect.overflowPx}px`).join(", ")}`,
        count: escaped.length,
        evidence: escaped.map((defect) => defect.selector),
      });
    }
  }

  return {
    verdict: { status: failures.length === 0 ? "pass" : "fail", failures, notes },
    fingerprints,
    newFindingFingerprints: freshSorted,
    knownFindingFingerprints: known,
    resolvedFindingFingerprints: resolved,
    countedFingerprints: counted,
  };
}

/** Human-readable threshold, for terminal output and the dashboard heading. */
export function describePolicy(policy: QualityPolicy): string {
  const parts = [`fail on ${policy.failOn}`];
  if (!policy.includeBestPractice) parts.push("best-practice rules excluded");
  if (policy.failOnNewOnly) parts.push("new findings only");
  parts.push(`max overflow ${policy.maxDocumentOverflowPx}px document / ${policy.maxElementOverflowPx}px element`);
  return parts.join(" · ");
}
