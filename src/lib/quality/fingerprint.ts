import type { AccessibilityFinding, AccessibilitySnapshot } from "./types";

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

/** The snapshot an approval records, so a later check has something trustworthy to diff. */
export function snapshotOf(
  findings: readonly AccessibilityFinding[],
  runnerVersion: string,
  approvedAt: string,
): AccessibilitySnapshot {
  const fingerprints = fingerprintViolations(findings);
  return { runnerVersion, approvedAt, fingerprints, violationCount: fingerprints.length };
}
