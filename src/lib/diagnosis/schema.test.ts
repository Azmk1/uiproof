import { describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import { extractJsonObject, validateDiagnosisResponse } from "./schema";
import type { DiagnosticIssue, SourceCandidate } from "./types";

/**
 * The validator is the only thing standing between a model's prose and the console, so it
 * is tested as hostile input: wrong keys, missing fields, invented paths and line numbers
 * that were never sent.
 */

const ISSUE: DiagnosticIssue = {
  key: "a11y:select-name@#booking-status",
  kind: "accessibility",
  title: "select-name on #booking-status",
  measured: [{ label: "Rule", value: "select-name" }],
  evidence: [],
};

const CANDIDATE: SourceCandidate = {
  path: "src/components/settings-form.tsx",
  via: ["contains the selector token \"booking-status\" (line 41)"],
  matchedLines: [41],
  excerptStartLine: 35,
  excerptEndLine: 50,
  excerpt: [
    "35:   return (",
    "36:     <form>",
    "40:       <select",
    "41:         id=\"booking-status\"",
    "42:         name=\"status\"",
    "50:     </form>",
  ].join("\n"),
  excerptTruncated: true,
};

const CANDIDATES = new Map([[ISSUE.key, [CANDIDATE]]]);

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issues: [
      {
        key: ISSUE.key,
        summary: "The status select has no accessible name.",
        likelyCause: "The label was moved out of the select's <label> element during the filter refactor.",
        repairApproach: "Wrap the select in a <label>, or add aria-label with the visible field name.",
        citedFacts: ["Rule: select-name", "Selector: #booking-status"],
        confidence: "medium",
        uncertainty: "The excerpt stops before the surrounding markup, so a wrapping label cannot be ruled out.",
        sources: [{ path: CANDIDATE.path, line: 41, why: "The select element reported by axe." }],
        ...overrides,
      },
    ],
  });
}

function refusal(raw: string, candidates = CANDIDATES): ComparisonError {
  try {
    validateDiagnosisResponse(raw, [ISSUE], candidates);
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonError);
    return error as ComparisonError;
  }
  throw new Error("expected the response to be refused");
}

describe("validateDiagnosisResponse", () => {
  it("accepts a well-formed answer and verifies the cited line against the excerpt", () => {
    const result = validateDiagnosisResponse(answer(), [ISSUE], CANDIDATES);
    const diagnosis = result.diagnoses.get(ISSUE.key);

    expect(result.warnings).toEqual([]);
    expect(diagnosis?.confidence).toBe("medium");
    expect(diagnosis?.citedFacts).toEqual(["Rule: select-name", "Selector: #booking-status"]);
    expect(diagnosis?.sources).toHaveLength(1);
    expect(diagnosis?.sources[0]).toMatchObject({
      path: CANDIDATE.path,
      line: 41,
      why: "The select element reported by axe.",
    });
    expect(diagnosis?.sources[0].lineText).toContain('id="booking-status"');
    expect(diagnosis?.unverifiedSources).toEqual([]);
  });

  it("accepts one JSON object wrapped in a markdown fence", () => {
    const fenced = `\`\`\`json\n${answer()}\n\`\`\``;
    expect(validateDiagnosisResponse(fenced, [ISSUE], CANDIDATES).diagnoses.size).toBe(1);
  });

  it("keeps a citation to a file it never sent as unverified rather than dropping it", () => {
    const raw = answer({
      sources: [{ path: "src/app/settings/page.tsx", line: 12, why: "Looks like the page component." }],
    });
    const result = validateDiagnosisResponse(raw, [ISSUE], CANDIDATES);
    const diagnosis = result.diagnoses.get(ISSUE.key);

    expect(diagnosis?.sources).toEqual([]);
    expect(diagnosis?.unverifiedSources[0]).toMatchObject({
      path: "src/app/settings/page.tsx",
      line: 12,
      reason: expect.stringContaining("UIProof did not read that file"),
    });
    expect(result.warnings[0]).toContain("1 citation(s) in a11y:select-name@#booking-status");
  });

  it("rejects a line number outside the excerpt that was actually shown", () => {
    const raw = answer({
      sources: [{ path: CANDIDATE.path, line: 200, why: "The label." }],
    });
    const diagnosis = validateDiagnosisResponse(raw, [ISSUE], CANDIDATES).diagnoses.get(ISSUE.key);

    expect(diagnosis?.sources).toEqual([]);
    expect(diagnosis?.unverifiedSources[0].reason).toContain("lines 35–50");
  });

  it("accepts a file-level citation with no line, because that claim is smaller", () => {
    const raw = answer({ sources: [{ path: CANDIDATE.path, line: null, why: "The settings form." }] });
    const diagnosis = validateDiagnosisResponse(raw, [ISSUE], CANDIDATES).diagnoses.get(ISSUE.key);
    expect(diagnosis?.sources).toEqual([
      { path: CANDIDATE.path, line: null, why: "The settings form.", lineText: null },
    ]);
  });

  it("refuses a key for an issue UIProof did not ask about", () => {
    const error = refusal(answer({ key: "a11y:made-up@#hero" }));
    expect(error.code).toBe("diagnosis_invalid_response");
    expect(error.message).toContain("which was not one of the issues UIProof sent");
  });

  it("refuses a confidence outside the three allowed values", () => {
    expect(refusal(answer({ confidence: "certain" })).message).toContain('"confidence"');
  });

  it("refuses an answer that drops a required field", () => {
    const parsed = JSON.parse(answer()) as { issues: Array<Record<string, unknown>> };
    delete parsed.issues[0].repairApproach;
    expect(refusal(JSON.stringify(parsed)).message).toContain('"repairApproach"');
  });

  it("refuses an over-long string rather than truncating what the model said", () => {
    expect(refusal(answer({ summary: "x".repeat(401) })).message).toContain("longer than 400 characters");
  });

  it("refuses prose around the JSON", () => {
    expect(refusal(`Here is my answer:\n${answer()}`).message).toContain("not valid JSON");
  });

  it("refuses text after a fenced block", () => {
    expect(refusal(`\`\`\`json\n${answer()}\n\`\`\`\nHope that helps!`).message).toContain(
      "text after the JSON block",
    );
  });

  it("refuses an answer that repeats one issue key", () => {
    const parsed = JSON.parse(answer()) as { issues: Array<Record<string, unknown>> };
    parsed.issues.push({ ...parsed.issues[0] });
    expect(refusal(JSON.stringify(parsed)).message).toContain("repeats");
  });

  it("reports an issue the model skipped as a warning, not as a fabricated diagnosis", () => {
    const other: DiagnosticIssue = { ...ISSUE, key: "visual:regression", kind: "visual", title: "Visual regression" };
    const result = validateDiagnosisResponse(answer(), [ISSUE, other], CANDIDATES);
    expect(result.diagnoses.has(other.key)).toBe(false);
    expect(result.warnings.join(" ")).toContain(`did not return a diagnosis for 1 issue(s): ${other.key}`);
  });

  it("ignores issues beyond the cap and says so", () => {
    const issues: DiagnosticIssue[] = Array.from({ length: 3 }, (_, index) => ({
      ...ISSUE,
      key: `a11y:rule-${index}`,
      title: `rule ${index}`,
    }));
    const parsed = JSON.parse(answer()) as { issues: Array<Record<string, unknown>> };
    parsed.issues = issues.map((issue) => ({ ...parsed.issues[0], key: issue.key }));

    const result = validateDiagnosisResponse(JSON.stringify(parsed), issues, new Map(), {
      maxIssues: 2,
      maxSourcesPerIssue: 8,
    });
    expect(result.diagnoses.size).toBe(2);
    expect(result.warnings[0]).toContain("1 extra issue(s) were ignored");
  });
});

describe("extractJsonObject", () => {
  it("returns the parsed object", () => {
    expect(extractJsonObject('{"issues":[]}')).toEqual({ issues: [] });
  });

  it("refuses an empty answer and an unterminated fence", () => {
    expect(() => extractJsonObject("   ")).toThrow(/empty/);
    expect(() => extractJsonObject("```json\n{")).toThrow(/unterminated/);
  });
});
