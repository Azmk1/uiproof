import { describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import type { QualitySection } from "@/lib/quality/types";
import { contextFromAudit, contextFromReport, requireDiagnosable } from "./context";
import { accessibility, auditReport, comparisonReport, finding, responsive, responsiveFinding } from "./test-fixtures";

/**
 * The context is where measurements become issues worth explaining, so these tests pin the
 * boundary in both directions: nothing that was measured is missing, and nothing that was
 * not measured — no guess, no cause, no file — appears in it.
 */

describe("issues from an audit", () => {
  it("turns a violation into an issue whose facts are the report's own numbers", () => {
    const report = auditReport();
    const context = contextFromAudit(report);

    const issue = context.issues.find((entry) => entry.kind === "accessibility");
    expect(issue).toBeDefined();
    expect(issue?.key).toBe("a11y:select-name@#booking-status");
    expect(issue?.hints).toEqual({
      selector: "#booking-status",
      html: report.viewports[2].accessibility.findings[0].html,
    });

    const facts = new Map(issue?.measured.map((fact) => [fact.label, fact.value]));
    expect(facts.get("Rule")).toBe("select-name");
    expect(facts.get("Impact")).toBe("critical");
    expect(facts.get("Selector")).toBe("#booking-status");
    expect(facts.get("WCAG tags")).toBe("wcag2a, wcag412");
    expect(facts.get("Measured at viewport(s)")).toBe("mobile");
  });

  it("keeps needs-review results out of the issues and says how many were left out", () => {
    const context = contextFromAudit(auditReport());
    const keys = context.issues.map((issue) => issue.key);
    expect(keys.some((key) => key.includes("color-contrast"))).toBe(false);
    expect(context.warnings.join(" ")).toContain("1 needs-review result(s) were not diagnosed");
  });

  it("deduplicates one fingerprint measured at several viewports", () => {
    const base = auditReport();
    const shared = finding();
    const report = auditReport({
      viewports: base.viewports.map((entry) => ({
        ...entry,
        accessibility: accessibility({
          counts: { minor: 0, moderate: 0, serious: 0, critical: 1, unknown: 0 },
          findings: [shared],
          totalFindings: 1,
        }),
      })),
    });

    const context = contextFromAudit(report);
    const accessibilityIssues = context.issues.filter((issue) => issue.kind === "accessibility");
    expect(accessibilityIssues).toHaveLength(1);
    expect(accessibilityIssues[0].measured.map((fact) => fact.value)).toContain("desktop, tablet, mobile");
    expect(accessibilityIssues[0].evidence.filter((entry) => entry.kind === "screenshot")).toHaveLength(3);
  });

  it("reports layout overflow with the measured pixels and never as a cause", () => {
    const context = contextFromAudit(auditReport());
    const layout = context.issues.find((issue) => issue.kind === "responsive");
    const facts = new Map(layout?.measured.map((fact) => [fact.label, fact.value]));
    expect(facts.get("Document overflow")).toBe("348px (limit 1px)");
    expect(facts.get("Escaping elements")).toContain("div.promo (+348px)");
    // Contained overflow is evidence, not a defect: it must not appear as an escaping element.
    expect(facts.get("Escaping elements")).not.toContain("div.table-wrap");
  });

  it("does not offer a clean viewport as an issue even when other viewports failed", () => {
    const context = contextFromAudit(auditReport());
    expect(context.issues.filter((issue) => issue.kind === "responsive")).toHaveLength(1);
  });

  it("warns when no approved reference exists, because 'new' cannot be told from 'known'", () => {
    const context = contextFromAudit(auditReport());
    expect(context.warnings.join(" ")).toContain("no approved accessibility reference");
  });
});

describe("issues from a comparison run", () => {
  it("describes a regression with the measured diff and links to its artifacts", () => {
    const report = comparisonReport();
    const context = contextFromReport(report);
    const issue = context.issues.find((entry) => entry.kind === "visual");

    expect(issue?.key).toBe("visual:regression");
    const facts = new Map(issue?.measured.map((fact) => [fact.label, fact.value]));
    expect(facts.get("Changed pixels")).toBe("54686");
    expect(facts.get("Share of the viewport changed")).toBe("5.3404%");
    expect(facts.get("Tolerance")).toBe("0.1%");

    const urls = issue?.evidence.map((entry) => entry.url);
    expect(urls).toContain(report.artifacts.diff?.url);
    expect(urls).toContain(report.artifacts.current.url);
  });

  it("adds the quality section's violations as their own issues", () => {
    const section: QualitySection = {
      policy: auditReport().policy,
      verdict: auditReport().verdict,
      accessibility: accessibility({
        counts: { minor: 0, moderate: 0, serious: 1, critical: 0, unknown: 0 },
        findings: [finding({ rule: "color-contrast", impact: "serious", selector: ".hint-subtle", fingerprint: "color-contrast@.hint-subtle" })],
        totalFindings: 1,
      }),
      responsive: responsive({ viewportId: "desktop", viewportWidth: 1280 }),
      references: [],
      newFindingFingerprints: [],
      knownFindingFingerprints: [],
      resolvedFindingFingerprints: [],
    };

    const context = contextFromReport(comparisonReport({ quality: section }));
    const rules = context.issues.map((issue) => issue.key);
    expect(rules).toContain("visual:regression");
    expect(rules).toContain("a11y:color-contrast@.hint-subtle");
  });

  it("adds a layout issue when the run measured overflow", () => {
    const section: QualitySection = {
      policy: auditReport().policy,
      verdict: auditReport().verdict,
      accessibility: accessibility(),
      responsive: responsive({
        viewportId: "desktop",
        viewportWidth: 1280,
        documentOverflowPx: 40,
        findings: [responsiveFinding({ viewportId: "desktop", viewportWidth: 1280, selector: "div.wide", overflowPx: 40 })],
      }),
      references: [],
      newFindingFingerprints: [],
      knownFindingFingerprints: [],
      resolvedFindingFingerprints: [],
    };
    const context = contextFromReport(comparisonReport({ quality: section }));
    expect(context.issues.some((issue) => issue.kind === "responsive")).toBe(true);
  });

  it("has nothing to diagnose when the run passed or only captured", () => {
    expect(contextFromReport(comparisonReport({ status: "pass" })).issues).toEqual([]);
    expect(contextFromReport(comparisonReport({ status: "captured", baseline: null })).issues).toEqual([]);
    expect(contextFromReport(comparisonReport({ status: "pass" })).warnings.join(" ")).toContain("no regression to explain");
  });
});

describe("requireDiagnosable", () => {
  it("refuses a report with nothing measured, instead of inventing a story", () => {
    const context = contextFromReport(comparisonReport({ status: "pass" }));
    try {
      requireDiagnosable(context, 4);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ComparisonError);
      expect((error as ComparisonError).code).toBe("diagnosis_nothing_to_diagnose");
      expect((error as ComparisonError).message).toContain("Nothing to diagnose");
    }
  });

  it("caps the issues it hands on, most severe first as the report listed them", () => {
    const context = contextFromAudit(auditReport());
    expect(requireDiagnosable(context, 1)).toHaveLength(1);
    expect(requireDiagnosable(context, 99)).toHaveLength(context.issues.length);
  });
});
