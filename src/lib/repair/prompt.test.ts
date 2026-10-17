import { describe, expect, it } from "vitest";
import type { DiagnosticContext } from "@/lib/diagnosis/context";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import { buildRepairPrompt, MAX_PROMPT_FILES, type RepairPromptFile } from "./prompt";
import type { RepairAttempt } from "./types";

const CONTEXT: DiagnosticContext = {
  reportId: null,
  auditId: "audit-1",
  scopeKey: "project:demo/support",
  sourceLabel: "Demo · Support",
  route: "/support",
  projectId: "demo",
  createdAt: "2026-01-01T00:00:00.000Z",
  issues: [],
  warnings: ["One needs-review result was not diagnosed."],
};

const ISSUES: DiagnosticIssue[] = [
  {
    key: "a11y:label@#email",
    kind: "accessibility",
    title: "label on #email",
    measured: [{ label: "Rule", value: "label" }, { label: "Selector", value: "#email" }],
    evidence: [],
    hints: { selector: "#email", html: '<input id="email">' },
  },
];

const FILE: RepairPromptFile = {
  path: "views/index.html",
  content: '<form>\n  <input id="email">\n</form>\n',
  truncated: false,
  why: ["contains the selector token \"email\""],
};

function attempt(overrides: Partial<RepairAttempt> = {}): RepairAttempt {
  return {
    attempt: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    durationMs: 100,
    proposal: {
      issueKey: "a11y:label@#email",
      title: "Add a label",
      summary: "Names the field.",
      explanation: "It had no name.",
      expectedImprovement: "The finding disappears.",
      uncertainty: null,
      confidence: "high",
      patch: "--- a/views/index.html\n+++ b/views/index.html\n@@ -2,1 +2,1 @@\n-old\n+new",
      files: [{ path: "views/index.html", additions: 1, deletions: 1 }],
      linesChanged: 2,
      applied: true,
    },
    model: null,
    rejection: null,
    patchArtifact: "attempt-1.patch",
    artifacts: [],
    verification: {
      verdict: "rejected",
      reasons: ["a11y:label@#email did not improve: The same rule still fires on the same element."],
      targets: [
        {
          issueKey: "a11y:label@#email",
          title: "label on #email",
          status: "unchanged",
          before: "1 violation(s) at Mobile",
          after: "1 violation(s) at Mobile",
          detail: "The same rule still fires on the same element.",
        },
      ],
      regressions: [],
      build: [
        {
          name: "build",
          command: ["node", "build.mjs"],
          status: "passed",
          exitCode: 0,
          durationMs: 3,
          outputTail: "",
          reason: null,
        },
      ],
      before: { phase: "before", startedAt: "x", totalMs: 1, pages: [], warnings: [] },
      after: { phase: "after", startedAt: "y", totalMs: 1, pages: [], warnings: [] },
      scope: { ok: true, files: ["views/index.html"], violations: [] },
      notes: [],
    },
    verdict: "rejected",
    ...overrides,
  };
}

describe("buildRepairPrompt", () => {
  it("includes measured issues, full source and the sandbox rules", () => {
    const prompt = buildRepairPrompt({ context: CONTEXT, issues: ISSUES, files: [FILE] });
    expect(prompt.system).toContain("Never claim the repair was applied or verified");
    expect(prompt.user).toContain("a11y:label@#email");
    expect(prompt.user).toContain('Rule: label');
    expect(prompt.user).toContain("views/index.html");
    expect(prompt.user).toContain('<input id="email">');
    expect(prompt.user).toContain("One needs-review result was not diagnosed.");
    expect(prompt.files).toEqual([FILE]);
  });

  it("drops files that do not fit the budget and says so", () => {
    const huge: RepairPromptFile = { path: "views/huge.html", content: "x".repeat(30_000), truncated: false, why: [] };
    const prompt = buildRepairPrompt({
      context: CONTEXT,
      issues: ISSUES,
      files: [FILE, huge],
      maxChars: 12_000,
    });
    expect(prompt.files.map((file) => file.path)).toEqual(["views/index.html"]);
    expect(prompt.warnings.join(" ")).toContain("views/huge.html was not sent");
  });

  it("caps the number of files shown", () => {
    const files = Array.from({ length: MAX_PROMPT_FILES + 2 }, (_, index) => ({
      path: `views/f${index}.html`,
      content: "<div></div>",
      truncated: false,
      why: [],
    }));
    const prompt = buildRepairPrompt({ context: CONTEXT, issues: ISSUES, files });
    expect(prompt.files).toHaveLength(MAX_PROMPT_FILES);
    expect(prompt.warnings.length).toBeGreaterThan(0);
  });

  it("carries the failed verification evidence into a revision prompt", () => {
    const prompt = buildRepairPrompt({
      context: CONTEXT,
      issues: ISSUES,
      files: [FILE],
      previous: attempt(),
    });
    expect(prompt.user).toContain("Previous attempt 1 was REJECTED");
    expect(prompt.user).toContain("did not improve");
    expect(prompt.user).toContain("Propose a DIFFERENT patch");
    expect(prompt.user).toContain("against the ORIGINAL file contents");
  });
});
