import type { AccessibilityFinding, AccessibilitySummary } from "@/lib/quality/types";

/**
 * The count line above a viewport's findings.
 *
 * `totalFindings` is every finding the scan produced — violations *and* needs-review
 * questions — so calling it "violations" made a clean page read `1 violation(s)` with every
 * impact count at zero. The pilot hit that on a page whose only finding was an undecidable
 * contrast question. Violations are what the policy judges, so they are what this line
 * counts, and the questions are reported beside them.
 */
export function accessibilitySummaryLine(summary: AccessibilitySummary): string {
  const violations = summary.totalFindings - summary.needsReview;
  return (
    `${violations} violation(s) ` +
    `(critical ${summary.counts.critical}, serious ${summary.counts.serious}, ` +
    `moderate ${summary.counts.moderate}, minor ${summary.counts.minor}, ` +
    `impact unstated ${summary.counts.unknown}), ` +
    `${summary.needsReview} need(s) review`
  );
}

/**
 * The human-readable lines for one measured finding in `uiproof audit`.
 *
 * Kept apart from the command so the shape of the output is unit tested: the distinction
 * the pilot needed is that a **violation** and a **needs-review question** are not the same
 * thing. A viewport can report `0 violation(s)` and still list twenty contrast lines under
 * it; without a marker those lines read as failures and the person reviewing them cannot
 * tell which ones the policy actually judged.
 *
 * So an undecided result is marked and a violation is not: the policy only ever fails on
 * violations, and anything the scanner could not decide is a question for a human.
 */
export function findingLines(finding: AccessibilityFinding): string[] {
  const impact = finding.impact ?? "unstated";
  const marker = finding.status === "needs-review" ? "  · needs review" : "";
  const lines = [`    [${impact}] ${finding.rule} — ${finding.selector}${marker}`];
  if (finding.help) lines.push(`        ${finding.help}`);
  if (finding.html) lines.push(`        ${finding.html}`);
  if (finding.summary) lines.push(`        ${finding.summary}`);
  return lines;
}
