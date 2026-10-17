import { describe, expect, it } from "vitest";
import {
  completeViolationFingerprints,
  diffFingerprints,
  fingerprintFinding,
  fingerprintViolations,
  parseAccessibilitySnapshot,
  snapshotOf,
  snapshotOfSummary,
} from "./fingerprint";
import type { AccessibilityFinding, AccessibilitySummary } from "./types";

function finding(overrides: Partial<AccessibilityFinding> = {}): AccessibilityFinding {
  const base: AccessibilityFinding = {
    rule: "button-name",
    impact: "critical",
    status: "violation",
    description: "Ensures buttons have discernible text",
    help: "Buttons must have discernible text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/button-name",
    wcagTags: ["wcag2a", "wcag412"],
    selector: "main > button.save",
    html: "<button class=\"save\"></button>",
    summary: "Element does not have inner text",
    fingerprint: "",
  };
  const merged = { ...base, ...overrides };
  // The fingerprint is derived from rule + selector exactly as the scanner derives it, so
  // a test that changes one of them changes the identity too.
  return {
    ...merged,
    fingerprint: overrides.fingerprint ?? fingerprintFinding({ rule: merged.rule, selector: merged.selector }),
  };
}

describe("fingerprintFinding", () => {
  it("is rule@selector, stable across calls", () => {
    const first = fingerprintFinding({ rule: "button-name", selector: "main > button" });
    const second = fingerprintFinding({ rule: "button-name", selector: "main > button" });
    expect(first).toBe("button-name@main > button");
    expect(first).toBe(second);
  });

  it("collapses whitespace so a reflowed selector is the same finding", () => {
    expect(fingerprintFinding({ rule: "label", selector: "form  >   input" })).toBe("label@form > input");
  });

  it("distinguishes elements and rules", () => {
    const a = fingerprintFinding({ rule: "button-name", selector: "#a" });
    const b = fingerprintFinding({ rule: "button-name", selector: "#b" });
    const c = fingerprintFinding({ rule: "link-name", selector: "#a" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("fingerprintViolations", () => {
  it("collects only violations, sorted and deduplicated", () => {
    const findings = [
      finding(),
      finding({ status: "needs-review" }),
      finding(), // duplicate
      finding({ rule: "label", selector: "#email" }),
    ];
    expect(fingerprintViolations(findings)).toEqual([
      "button-name@main > button.save",
      "label@#email",
    ]);
  });

  it("is empty for a clean scan", () => {
    expect(fingerprintViolations([])).toEqual([]);
    expect(fingerprintViolations([finding({ status: "needs-review" })])).toEqual([]);
  });
});

describe("diffFingerprints", () => {
  it("separates added, known and resolved", () => {
    const diff = diffFingerprints(["a@1", "b@2"], ["b@2", "c@3"]);
    expect(diff.added).toEqual(["a@1"]);
    expect(diff.known).toEqual(["b@2"]);
    expect(diff.resolved).toEqual(["c@3"]);
  });

  it("treats both sides as unordered sets", () => {
    const diff = diffFingerprints(["z@9", "a@1"], ["a@1", "z@9"]);
    expect(diff.added).toEqual([]);
    expect(diff.known).toEqual(["a@1", "z@9"]);
    expect(diff.resolved).toEqual([]);
  });

  it("with an empty reference every violation is added, nothing is known", () => {
    const diff = diffFingerprints(["a@1"], []);
    expect(diff.added).toEqual(["a@1"]);
    expect(diff.known).toEqual([]);
    expect(diff.resolved).toEqual([]);
  });
});

describe("snapshotOf", () => {
  it("records exactly the violation fingerprints and their count", () => {
    const snapshot = snapshotOf(
      [finding(), finding({ status: "needs-review" }), finding({ rule: "label", selector: "#email" })],
      "4.14.0",
      "2026-10-15T00:00:00.000Z",
    );
    expect(snapshot.runnerVersion).toBe("4.14.0");
    expect(snapshot.approvedAt).toBe("2026-10-15T00:00:00.000Z");
    expect(snapshot.fingerprints).toEqual(["button-name@main > button.save", "label@#email"]);
    expect(snapshot.violationCount).toBe(2);
  });
});

function summaryWith(overrides: Partial<AccessibilitySummary>): AccessibilitySummary {
  return {
    runner: { name: "axe-core", version: "4.14.0", rulesEvaluated: 10, ruleSets: ["wcag2a"], nodeResults: 12 },
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

describe("completeViolationFingerprints", () => {
  it("reads the complete index, so a display cap cannot shrink an approval", () => {
    const summary = summaryWith({
      findings: [finding({ rule: "region", selector: "footer" })],
      violations: [
        { fingerprint: "region@footer", impact: "minor", wcag: false },
        { fingerprint: "label@#email", impact: "critical", wcag: true },
      ],
      truncated: true,
      totalFindings: 75,
    });
    expect(completeViolationFingerprints(summary)).toEqual(["label@#email", "region@footer"]);
  });

  it("falls back to the display list only for reports written before the index existed", () => {
    const legacy = summaryWith({ findings: [finding()] });
    delete (legacy as { violations?: unknown }).violations;
    expect(completeViolationFingerprints(legacy)).toEqual(["button-name@main > button.save"]);
  });

  it("approves from the complete index", () => {
    const summary = summaryWith({
      violations: [{ fingerprint: "label@#email", impact: "critical", wcag: true }],
      totalFindings: 1,
    });
    const snapshot = snapshotOfSummary(summary, "2026-10-15T00:00:00.000Z");
    expect(snapshot.fingerprints).toEqual(["label@#email"]);
    expect(snapshot.violationCount).toBe(1);
  });
});

describe("parseAccessibilitySnapshot", () => {
  const valid = {
    runnerVersion: "4.14.0",
    approvedAt: "2026-10-15T00:00:00.000Z",
    fingerprints: ["label@#email", "region@footer"],
    violationCount: 2,
  };

  it("accepts a well-formed snapshot and returns it unchanged", () => {
    expect(parseAccessibilitySnapshot(valid)).toEqual(valid);
    expect(parseAccessibilitySnapshot({ ...valid, fingerprints: [], violationCount: 0 })).toEqual({
      ...valid,
      fingerprints: [],
      violationCount: 0,
    });
  });

  it("refuses anything that would make an approval ambiguous", () => {
    for (const bad of [null, [], "snapshot", 42]) {
      expect(() => parseAccessibilitySnapshot(bad), String(bad)).toThrow(/JSON object/);
    }
    expect(() => parseAccessibilitySnapshot({ ...valid, extra: 1 })).toThrow(/unknown accessibility snapshot field/);
    expect(() => parseAccessibilitySnapshot({ ...valid, runnerVersion: "" })).toThrow(/runnerVersion/);
    expect(() => parseAccessibilitySnapshot({ ...valid, approvedAt: "yesterday" })).toThrow(/approvedAt/);
    expect(() => parseAccessibilitySnapshot({ ...valid, fingerprints: "label@#email" })).toThrow(/array/);
    expect(() => parseAccessibilitySnapshot({ ...valid, fingerprints: ["label@#email", "label@#email"] })).toThrow(/more than once/);
    expect(() => parseAccessibilitySnapshot({ ...valid, fingerprints: ["region@footer", "label@#email"] })).toThrow(/sorted order/);
    expect(() => parseAccessibilitySnapshot({ ...valid, fingerprints: ["no-at-sign"] })).toThrow(/fingerprint/);
    expect(() => parseAccessibilitySnapshot({ ...valid, violationCount: 1 })).toThrow(/claims 1 violation/);
    expect(() => parseAccessibilitySnapshot({ ...valid, violationCount: -1 })).toThrow(/violationCount/);
  });

  it("round-trips a snapshot through JSON", () => {
    const snapshot = snapshotOf([finding()], "4.14.0", "2026-10-15T00:00:00.000Z");
    expect(parseAccessibilitySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
});

