import type { AccessibilityFinding, AccessibilitySnapshot, AccessibilitySummary } from "./types";

/**
 * Finding identity.
 *
 * The point of a fingerprint is that a later scan can say "this one is new" without
 * comparing counts, which drift for reasons that have nothing to do with the page (a rule
 * set upgrade, a viewport difference, the order the runner walked the DOM in).
 *
 * The identity of an accessibility finding is **the rule that fired and the element it
 * fired on**: `<rule>@<selector>`. That is deliberately coarse in one direction and fine
 * in another:
 *
 *  · Two `<button>` elements each missing a name are two findings, because their selectors
 *    differ — which is what a reviewer needs to see.
 *  · The same element failing the same rule before and after a cosmetic edit is one
 *    finding, so a reworded label does not read as a new violation.
 *  · A rule that stops firing removes its fingerprint, so a fix is visible as a removal.
 *
 * The caveat is worth stating plainly: a selector can change without the problem changing
 * (a sibling is added and a structural selector shifts). That direction produces a false
 * "new", never a false "known", which is the safe way for a gate to be wrong.
 */

/** Longest selector kept in a fingerprint; beyond that the fingerprint is truncated. */
export const MAX_FINGERPRINT_LENGTH = 240;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `rule@selector`, bounded, so a fingerprint stays readable inside a JSON report. */
export function fingerprintFinding(finding: { readonly rule: string; readonly selector: string }): string {
  const value = `${collapse(finding.rule)}@${collapse(finding.selector)}`;
  return value.length <= MAX_FINGERPRINT_LENGTH ? value : value.slice(0, MAX_FINGERPRINT_LENGTH);
}

/** Sorted, deduplicated fingerprints of the violations in a scan. */
export function fingerprintViolations(findings: readonly AccessibilityFinding[]): string[] {
  const fingerprints = new Set<string>();
  for (const finding of findings) {
    if (finding.status !== "violation") continue;
    fingerprints.add(finding.fingerprint);
  }
  return [...fingerprints].sort();
}

export interface FindingDiff {
  /** Present now, absent from the reference. */
  readonly added: readonly string[];
  /** Present in both. */
  readonly known: readonly string[];
  /** In the reference and no longer present — the fixes. */
  readonly resolved: readonly string[];
}

/**
 * Compares two fingerprint sets. Both sides are treated as unordered sets of strings; the
 * result is sorted so two runs over the same evidence produce the same report bytes.
 */
export function diffFingerprints(current: readonly string[], reference: readonly string[]): FindingDiff {
  const now = new Set(current);
  const before = new Set(reference);
  const added: string[] = [];
  const known: string[] = [];
  const resolved: string[] = [];

  for (const value of now) (before.has(value) ? known : added).push(value);
  for (const value of before) if (!now.has(value)) resolved.push(value);

  return { added: added.sort(), known: known.sort(), resolved: resolved.sort() };
}

/** True when a scan carries the complete violation index (Phase 5.1 and later). */
export function hasCompleteViolationIndex(summary: AccessibilitySummary): boolean {
  return Array.isArray(summary.violations);
}

/**
 * Every violation fingerprint in a scan.
 *
 * Reads the complete index, so a display cap cannot shrink an approval or a policy input.
 * Reports written before the index existed fall back to the readable list — and the caller
 * can tell the difference with `hasCompleteViolationIndex`.
 */
export function completeViolationFingerprints(summary: AccessibilitySummary): string[] {
  if (hasCompleteViolationIndex(summary)) {
    const unique = new Set<string>();
    for (const violation of summary.violations) {
      if (typeof violation?.fingerprint === "string" && violation.fingerprint.length > 0) {
        unique.add(violation.fingerprint);
      }
    }
    return [...unique].sort();
  }
  return fingerprintViolations(summary.findings);
}

/** The snapshot an approval records, so a later check has something trustworthy to diff. */
export function snapshotOf(
  findings: readonly AccessibilityFinding[],
  runnerVersion: string,
  approvedAt: string,
): AccessibilitySnapshot {
  const fingerprints = fingerprintViolations(findings);
  return { runnerVersion, approvedAt, fingerprints, violationCount: fingerprints.length };
}

/** The snapshot for an approval, from the complete measurement rather than the display list. */
export function snapshotOfSummary(summary: AccessibilitySummary, approvedAt: string): AccessibilitySnapshot {
  const fingerprints = completeViolationFingerprints(summary);
  return {
    runnerVersion: summary.runner.version,
    approvedAt,
    fingerprints,
    violationCount: fingerprints.length,
  };
}

const SNAPSHOT_KEYS = ["runnerVersion", "approvedAt", "fingerprints", "violationCount"] as const;

/**
 * Reads an accessibility snapshot from untrusted input (a bundle manifest, an import call).
 *
 * Strict on purpose: fingerprints must be unique, sorted, bounded and shaped like
 * `<rule>@<selector>`; `violationCount` must agree with the list; unknown fields are
 * refused. An approval is a trust anchor, so a malformed one is an error, never a guess.
 */
export function parseAccessibilitySnapshot(input: unknown): AccessibilitySnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RangeError("an accessibility snapshot must be a JSON object");
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(SNAPSHOT_KEYS as readonly string[]).includes(key)) {
      throw new RangeError(`unknown accessibility snapshot field ${JSON.stringify(key)}`);
    }
  }

  const runnerVersion = source.runnerVersion;
  if (typeof runnerVersion !== "string" || runnerVersion.trim().length === 0) {
    throw new RangeError('the accessibility snapshot is missing a usable "runnerVersion"');
  }
  const approvedAt = source.approvedAt;
  if (typeof approvedAt !== "string" || Number.isNaN(Date.parse(approvedAt))) {
    throw new RangeError('the accessibility snapshot is missing a usable "approvedAt"');
  }

  const rawFingerprints = source.fingerprints;
  if (!Array.isArray(rawFingerprints)) {
    throw new RangeError('the accessibility snapshot needs a "fingerprints" array');
  }
  const fingerprints: string[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const entry of rawFingerprints) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_FINGERPRINT_LENGTH) {
      throw new RangeError("every accessibility fingerprint must be a bounded, non-empty string");
    }
    if (!entry.includes("@")) {
      throw new RangeError(`not a <rule>@<selector> fingerprint: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry)) {
      throw new RangeError(`fingerprint ${JSON.stringify(entry)} appears more than once`);
    }
    if (previous.length > 0 && entry < previous) {
      throw new RangeError("accessibility fingerprints must be stored in sorted order");
    }
    seen.add(entry);
    previous = entry;
    fingerprints.push(entry);
  }

  const violationCount = source.violationCount;
  if (typeof violationCount !== "number" || !Number.isInteger(violationCount) || violationCount < 0) {
    throw new RangeError('the accessibility snapshot needs an integer "violationCount"');
  }
  if (violationCount !== fingerprints.length) {
    throw new RangeError(
      `the snapshot claims ${violationCount} violation(s) but lists ${fingerprints.length} fingerprint(s)`,
    );
  }

  return { runnerVersion, approvedAt, fingerprints, violationCount };
}
