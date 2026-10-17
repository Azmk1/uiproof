import { describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import { extractRepairJson, validateRepairProposal } from "./proposal";

const ISSUES: DiagnosticIssue[] = [
  { key: "a11y:label@#email", kind: "accessibility", title: "label on #email", measured: [], evidence: [] },
  { key: "responsive:mobile", kind: "responsive", title: "Overflow at Mobile", measured: [], evidence: [] },
];

const PATCH = ["--- a/views/index.html", "+++ b/views/index.html", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");

function json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issueKey: "a11y:label@#email",
    title: "Add a label",
    summary: "Names the email field.",
    explanation: "The control had nothing naming it.",
    expectedImprovement: "label@#email should disappear.",
    uncertainty: null,
    confidence: "high",
    patch: PATCH,
    ...overrides,
  });
}

function codeOf(run: () => unknown): ComparisonError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonError);
    return error as ComparisonError;
  }
  throw new Error("expected the call to throw");
}

describe("validateRepairProposal", () => {
  it("accepts the documented shape and a fenced object", () => {
    const proposal = validateRepairProposal(json(), ISSUES);
    expect(proposal.issueKey).toBe("a11y:label@#email");
    expect(proposal.confidence).toBe("high");
    expect(proposal.patch).toContain("--- a/views/index.html");

    const fenced = validateRepairProposal(`\`\`\`json\n${json()}\n\`\`\``, ISSUES);
    expect(fenced.title).toBe("Add a label");
  });

  it("accepts a declined patch as an honest, empty proposal", () => {
    const proposal = validateRepairProposal(json({ patch: "", uncertainty: "The excerpts do not show the element." }), ISSUES);
    expect(proposal.patch).toBe("");
  });

  it("refuses an issue key UIProof did not send", () => {
    const error = codeOf(() => validateRepairProposal(json({ issueKey: "a11y:invented@#x" }), ISSUES));
    expect(error.code).toBe("repair_invalid_response");
    expect(error.message).toContain("was not one of the issues");
  });

  it("refuses a patch that is not a unified diff", () => {
    expect(codeOf(() => validateRepairProposal(json({ patch: "just change the colour" }), ISSUES)).code).toBe(
      "repair_invalid_response",
    );
  });

  it("refuses missing fields, wrong types and text after the JSON", () => {
    for (const raw of [
      json({ title: undefined }),
      json({ confidence: "certain" }),
      json({ summary: 42 }),
      `${json()} trailing prose`,
      "{",
    ]) {
      expect(codeOf(() => validateRepairProposal(String(raw), ISSUES)).code).toBe("repair_invalid_response");
    }
  });

  it("extracts exactly one JSON object", () => {
    expect(extractRepairJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => extractRepairJson("```json\n```")).toThrow(ComparisonError);
    expect(() => extractRepairJson("```json\n{}\n```\nmore")).toThrow(ComparisonError);
  });
});
