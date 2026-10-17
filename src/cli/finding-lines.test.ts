import { describe, expect, it } from "vitest";
import type { AccessibilityFinding, AccessibilitySummary } from "@/lib/quality/types";
import { accessibilitySummaryLine, findingLines } from "./finding-lines";

function finding(overrides: Partial<AccessibilityFinding> = {}): AccessibilityFinding {
  return {
    rule: "color-contrast",
    impact: "serious",
    status: "violation",
    description: "Elements must meet minimum color contrast ratio thresholds",
    help: "Ensure the contrast between foreground and background colors meets WCAG 2 AA",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
    wcagTags: ["wcag2aa"],
    selector: ".hint-subtle",
    html: '<span class="hint-subtle">Replies land here.</span>',
    summary: "Fix any of the following: Element has insufficient color contrast of 2.4",
    fingerprint: "color-contrast@.hint-subtle",
    ...overrides,
  };
}

function summary(overrides: Partial<AccessibilitySummary> = {}): AccessibilitySummary {
  return {
    runner: { name: "axe-core", version: "4.14.0", rulesEvaluated: 30, ruleSets: ["wcag2aa"], nodeResults: 0 },
    counts: { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 },
    needsReview: 0,
    bestPracticeViolations: 0,
    findings: [],
    violations: [],
    truncated: false,
    totalFindings: 0,
    skippedResults: 0,
    ...overrides,
  };
}

describe("accessibilitySummaryLine", () => {
  it("counts violations, not questions, when a page has only needs-review results", () => {
    const line = accessibilitySummaryLine(
      summary({ needsReview: 24, totalFindings: 24 }),
    );
    expect(line).toContain("0 violation(s)");
    expect(line).toContain("24 need(s) review");
  });

  it("reports the impact counts and the questions side by side", () => {
    const line = accessibilitySummaryLine(
      summary({ counts: { minor: 1, moderate: 0, serious: 2, critical: 1, unknown: 0 }, needsReview: 3, totalFindings: 7 }),
    );
    expect(line).toBe(
      "4 violation(s) (critical 1, serious 2, moderate 0, minor 1, impact unstated 0), 3 need(s) review",
    );
  });
});

describe("findingLines", () => {
  it("marks a needs-review result, so it cannot be read as a violation", () => {
    const lines = findingLines(finding({ status: "needs-review", rule: "color-contrast" }));
    expect(lines[0]).toBe("    [serious] color-contrast — .hint-subtle  · needs review");
  });

  it("leaves a violation unmarked — it is what the policy judged", () => {
    const lines = findingLines(finding());
    expect(lines[0]).toBe("    [serious] color-contrast — .hint-subtle");
    expect(lines[0]).not.toContain("needs review");
  });

  it("carries the evidence under the finding: remediation, markup, failure summary", () => {
    const lines = findingLines(finding());
    expect(lines[1]).toContain("Ensure the contrast");
    expect(lines[2]).toContain("hint-subtle");
    expect(lines[3]).toContain("2.4");
  });

  it("says the impact is unstated when the runner did not supply one", () => {
    const lines = findingLines(finding({ impact: null, rule: "select-name", selector: "#booking-status" }));
    expect(lines[0]).toBe("    [unstated] select-name — #booking-status");
  });

  it("does not invent evidence that is not there", () => {
    const lines = findingLines(finding({ help: "", html: "", summary: "" }));
    expect(lines).toHaveLength(1);
  });
});
