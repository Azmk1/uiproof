import { diffFingerprints, fingerprintViolations } from "./fingerprint";
import {
  IMPACT_ORDER,
  type AccessibilityFinding,
  type AccessibilitySummary,
  type AxeImpact,
  type QualityFailure,
  type QualityPolicy,
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

function meetsThreshold(finding: AccessibilityFinding, policy: QualityPolicy): boolean {
  if (policy.failOn === "none") return false;
  if (!policy.includeBestPractice && finding.wcagTags.length === 0) return false;
  return rank(finding.impact) >= IMPACT_ORDER.indexOf(policy.failOn);
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
  /** Fingerprints of violations already present in the approved reference, or `null`. */
  readonly referenceFingerprints: readonly string[] | null;
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
 */
export function evaluateQualityPolicy(input: QualityVerdictInput): QualityVerdictResult {
  const { policy } = input;
  const notes: string[] = [];

  const allFindings: AccessibilityFinding[] = [];
  for (const viewport of input.viewports) allFindings.push(...viewport.accessibility.findings);
  const fingerprints = fingerprintViolations(allFindings);

  const reference = input.referenceFingerprints;
  if (policy.failOnNewOnly && reference === null) {
    notes.push(
      "failOnNewOnly is on, but no approved baseline records an accessibility snapshot for this scope, so every finding counts. Approve a run to establish the reference.",
    );
  }
  const diff = diffFingerprints(fingerprints, reference ?? []);
  const known = reference === null ? [] : diff.known;
  const fresh = reference === null ? fingerprints : diff.added;
  const resolved = reference === null ? [] : diff.resolved;
  const counted = policy.failOnNewOnly && reference !== null ? fresh : fingerprints;

  const failures: QualityFailure[] = [];

  if (policy.failOn !== "none") {
    const byCode = new Map<string, { count: number; evidence: string[] }>();
    const seen = new Set<string>();
    for (const viewport of input.viewports) {
      for (const finding of viewport.accessibility.findings) {
        if (finding.status !== "violation") continue;
        if (!counted.includes(finding.fingerprint)) continue;
        if (!meetsThreshold(finding, policy)) continue;
        if (seen.has(finding.fingerprint)) continue;
        seen.add(finding.fingerprint);
        const code = `accessibility.${finding.impact ?? "unknown"}`;
        const bucket = byCode.get(code) ?? { count: 0, evidence: [] };
        bucket.count += 1;
        bucket.evidence.push(finding.fingerprint);
        byCode.set(code, bucket);
      }
    }

    for (const code of IMPACT_CODES.map((impact) => `accessibility.${impact}`)) {
      const bucket = byCode.get(code);
      if (!bucket) continue;
      const impact = code.slice("accessibility.".length);
      const scope = policy.failOnNewOnly && reference !== null ? "new " : "";
      failures.push({
        kind: "accessibility",
        code,
        message: `${bucket.count} ${scope}accessibility violation${bucket.count === 1 ? "" : "s"} at impact "${impact}" meet the "${policy.failOn}" threshold (rule@selector): ${bucket.evidence.join(", ")}`,
        count: bucket.count,
        evidence: bucket.evidence,
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
    const escaped = viewport.responsive.findings.filter(
      (finding) => finding.overflowPx > policy.maxElementOverflowPx,
    );
    if (escaped.length > 0) {
      failures.push({
        kind: "responsive",
        code: "responsive.element-overflow",
        message: `${escaped.length} element${escaped.length === 1 ? "" : "s"} escape${escaped.length === 1 ? "s" : ""} the ${measuredAt} viewport (limit ${policy.maxElementOverflowPx}px): ${escaped.map((finding) => `${finding.selector} +${finding.overflowPx}px`).join(", ")}`,
        count: escaped.length,
        evidence: escaped.map((finding) => finding.selector),
      });
    }
  }

  return {
    verdict: { status: failures.length === 0 ? "pass" : "fail", failures, notes },
    fingerprints,
    newFindingFingerprints: fresh,
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
