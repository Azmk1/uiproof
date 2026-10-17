import { describe, expect, it } from "vitest";
import { diffFingerprints, fingerprintFinding, fingerprintViolations, snapshotOf } from "./fingerprint";
import type { AccessibilityFinding } from "./types";

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
