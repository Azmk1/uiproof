import type { DiagnosticContext } from "@/lib/diagnosis/context";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import type { RepairAttempt } from "./types";

/**
 * The prompt that asks for a repair proposal.
 *
 * Assembled from four things and nothing else: the measured issues copied out of a stored
 * report, the full text of the source files UIProof copied from the registered directory,
 * the sandbox rules the validator will enforce, and — on a second attempt — the measured
 * evidence of why the first patch failed.
 *
 * There is no hidden instruction and no tool use: the model returns one JSON object with a
 * unified diff. It cannot run a command, read a file UIProof did not send, or ask for a
 * path outside the source directory. The prompt says so, and the validator re-checks it.
 */

export const MAX_REPAIR_PROMPT_CHARS = 40_000;
export const MAX_PROMPT_FILE_CHARS = 12_000;
export const MAX_PROMPT_FILES = 4;

const SYSTEM_PROMPT = `You are UIProof's repair assistant. UIProof renders a page in Chromium, compares it against an approved baseline, and scans it with axe-core. You are given defects UIProof measured and the exact contents of the source files it copied from the registered application directory.

Your job is to propose ONE narrowly scoped repair for ONE measured issue, as a unified diff.

Rules, all checked when your answer is read:
1. The diff must apply exactly, with no fuzz, to the file contents below. Copy context lines character for character, including indentation. Do not abbreviate hunks or write "...".
2. Only modify files whose full contents are shown below. Do not create or delete files, rename files, or touch secrets, dependency manifests, lockfiles, generated output, CI configuration, the UIProof registration file or approved baselines.
3. Keep the change small: at most 4 files and 200 changed lines. Prefer the smallest edit that removes the measured defect without changing unrelated rendering.
4. Address exactly one issue key from the list. If the evidence does not support a safe patch, return an empty "patch" string and explain why in "uncertainty".
5. Never claim the repair was applied or verified. You are proposing; UIProof measures the result in an isolated copy and decides.
6. Answer with a single JSON object and nothing else — no prose, no markdown fences.

The sandbox runs the application with no secrets and no access to UIProof's store. Do not add network calls, analytics, credential reads or shell commands to the application.`;

const SCHEMA_PROMPT = `Reply with exactly this shape:
{
  "issueKey": "<one exact issue key from the list>",
  "title": "a short name for the change",
  "summary": "one sentence: what this change does",
  "explanation": "why this source edit addresses the measured defect",
  "expectedImprovement": "the measurement you expect to change, and in which direction",
  "uncertainty": "what could still go wrong, or null",
  "confidence": "high" | "medium" | "low",
  "patch": "--- a/path/from/the/source\\n+++ b/path/from/the/source\\n@@ -1,1 +1,1 @@\\n-old line\\n+new line"
}
The patch is a standard unified diff with a/ and b/ prefixes. Use \\n newlines inside the JSON string.`;

function measurableLines(issue: DiagnosticIssue): string {
  const lines = [`  title: ${issue.title}`, `  kind: ${issue.kind}`, "  measured:"];
  for (const fact of issue.measured) lines.push(`    - ${fact.label}: ${fact.value}`);
  if (issue.hints?.selector) lines.push(`  element selector: ${issue.hints.selector}`);
  if (issue.hints?.html) lines.push(`  element markup: ${issue.hints.html}`);
  return lines.join("\n");
}

export interface RepairPromptFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly why: readonly string[];
}

function fileBlock(file: RepairPromptFile): string {
  return [
    `  file: ${file.path}${file.truncated ? " (truncated; do not patch a file you cannot see completely)" : ""}`,
    file.why.length > 0 ? `  why it was selected:\n${file.why.map((reason) => `    · ${reason}`).join("\n")}` : "",
    "  ```",
    file.content,
    "  ```",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export interface RepairPrompt {
  readonly system: string;
  readonly user: string;
  readonly chars: number;
  /** Files whose full contents fit in the prompt. */
  readonly files: readonly RepairPromptFile[];
  readonly warnings: readonly string[];
}

export interface BuildRepairPromptInput {
  readonly context: DiagnosticContext;
  readonly issues: readonly DiagnosticIssue[];
  readonly files: readonly RepairPromptFile[];
  /** Present on a second attempt: what the first one measured. */
  readonly previous?: RepairAttempt | null;
  readonly maxChars?: number;
}

function previousAttemptBlock(attempt: RepairAttempt): string {
  const lines = [
    `Previous attempt ${attempt.attempt} was ${attempt.verdict.toUpperCase()} and must not be repeated.`,
  ];
  if (attempt.rejection) lines.push(`It was refused before running: ${attempt.rejection}`);
  if (attempt.proposal) {
    lines.push(`It proposed changes to: ${attempt.proposal.files.map((file) => file.path).join(", ") || "no files"}`);
    lines.push("Its diff was:");
    lines.push("  ```diff");
    lines.push(
      attempt.proposal.patch
        .split("\n")
        .slice(0, 120)
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    lines.push("  ```");
  }
  const verification = attempt.verification;
  if (verification) {
    lines.push("");
    lines.push("Measured result:");
    for (const target of verification.targets) {
      lines.push(`  · ${target.issueKey}: ${target.status.toUpperCase()} (before: ${target.before}; after: ${target.after}) — ${target.detail}`);
    }
    for (const regression of verification.regressions) {
      lines.push(`  · ${regression.kind}/${regression.id}: ${regression.status.toUpperCase()} — ${regression.detail}`);
    }
    for (const command of verification.build) {
      lines.push(`  · ${command.name}: ${command.status.toUpperCase()}${command.reason ? ` — ${command.reason}` : ""}`);
      if (command.status === "failed" && command.outputTail.length > 0) {
        lines.push(`    output tail: ${command.outputTail.split("\n").slice(-8).join(" | ")}`);
      }
    }
    if (verification.reasons.length > 0) {
      lines.push(`  Why it was not accepted: ${verification.reasons.join(" ")}`);
    }
  }
  lines.push("");
  lines.push(
    "Propose a DIFFERENT patch, written against the ORIGINAL file contents below (not against your previous diff).",
  );
  return lines.join("\n");
}

/**
 * Assembles the prompt. Files that do not fit the budget are dropped with a warning; an
 * issue whose file was dropped is still listed, so the model can decline rather than guess.
 */
export function buildRepairPrompt(input: BuildRepairPromptInput): RepairPrompt {
  const maxChars = input.maxChars ?? MAX_REPAIR_PROMPT_CHARS;
  const warnings: string[] = [];

  const files: RepairPromptFile[] = [];
  let budget = maxChars - SYSTEM_PROMPT.length - 6_000;
  for (const file of input.files) {
    const cost = file.content.length;
    if (files.length >= MAX_PROMPT_FILES) {
      warnings.push(`${file.path} was not sent: at most ${MAX_PROMPT_FILES} files fit in one proposal prompt.`);
      continue;
    }
    if (cost > budget) {
      warnings.push(`${file.path} was not sent: the prompt would exceed ${maxChars} characters.`);
      continue;
    }
    budget -= cost;
    files.push(file);
  }

  const issueBlocks = input.issues.map((issue) => `- issue key: ${issue.key}\n${measurableLines(issue)}`);
  const user = [
    "UIProof repair request",
    `Source under test: ${input.context.sourceLabel}${input.context.route ? ` at ${input.context.route}` : ""}`,
    `Scope: ${input.context.scopeKey}`,
    input.context.auditId ? `Audit: ${input.context.auditId}` : `Run: ${input.context.reportId}`,
    `Measured at: ${input.context.createdAt}`,
    input.context.warnings.length > 0
      ? `UIProof's own caveats about this report:\n${input.context.warnings.map((warning) => `  · ${warning}`).join("\n")}`
      : "",
    "",
    `Measured issues (${input.issues.length}):`,
    issueBlocks.join("\n\n"),
    "",
    files.length > 0
      ? `Source files you may patch (full contents, copied from the registered directory):\n${files.map(fileBlock).join("\n\n")}`
      : "No source file was available to patch. Return an empty patch and say so in \"uncertainty\".",
    "",
    input.previous ? previousAttemptBlock(input.previous) : "",
    "",
    SCHEMA_PROMPT,
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    system: SYSTEM_PROMPT,
    user,
    chars: user.length + SYSTEM_PROMPT.length,
    files,
    warnings,
  };
}

/** The context a revision prompt needs about the files it may patch again. */
export function describePromptFiles(files: readonly RepairPromptFile[]): string {
  return files.map((file) => file.path).join(", ");
}
