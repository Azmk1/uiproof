import type { DiagnosticContext } from "./context";
import type { DiagnosticIssue, SourceCandidate } from "./types";

/**
 * The prompt UIProof sends.
 *
 * It is assembled from exactly three things: measured facts copied out of a stored report,
 * numbered excerpts of files UIProof itself read from a registered directory, and the
 * instructions below. There is no hidden context, no network fetch and no system prompt the
 * caller cannot see — a test asserts the assembled prompt is deterministic for a given
 * report and workspace.
 *
 * The instructions are the contract the validator then enforces: cite only the excerpts,
 * invent nothing, admit uncertainty, and answer with one JSON object.
 */

export const MAX_PROMPT_CHARS = 24_000;
const MAX_CANDIDATE_CHARS = 16_000;
const EXCERPT_CHARS_PER_FILE = 6_000;

const SYSTEM_PROMPT = `You are UIProof's diagnostic assistant. UIProof renders a page in Chromium, compares it against an approved baseline, and scans it with axe-core. Your job is to help the developer understand a defect it measured.

Rules, all of which are checked when your answer is read:
1. Measured facts are the numbers, rules, selectors and viewport sizes given below. Never invent a value, a rule, a file, a line or a screenshot.
2. You may cite only files and lines shown in the numbered excerpts. A citation to anything else is rejected and reported to the developer as unverified.
3. If the excerpts do not explain the measurement, say so in "uncertainty", choose a lower confidence, and return as few sources as the evidence supports — an empty array is a valid and useful answer.
4. Describe repairs in words. Do not write patches, do not claim a change was applied, and do not modify anything: this tool never edits code.
5. Answer with a single JSON object and nothing else — no prose, no markdown fences.`;

const SCHEMA_PROMPT = `Reply with exactly this shape:
{
  "issues": [
    {
      "key": "<the exact key of one issue below>",
      "summary": "one sentence: what a user of this page would experience",
      "likelyCause": "the most likely cause, grounded in the excerpts",
      "repairApproach": "what to change, and how to verify it afterwards — words only",
      "citedFacts": ["short quotes of the measured facts you relied on"],
      "confidence": "high" | "medium" | "low",
      "uncertainty": "what the evidence does not tell you, or null",
      "sources": [
        { "path": "path/from/the/excerpts", "line": 42, "why": "what this line does" }
      ]
    }
  ]
}
Return one entry per issue you can say something useful about; omit an issue you cannot
diagnose at all rather than guessing.`;

function measurableLines(issue: DiagnosticIssue): string {
  const lines = [`  title: ${issue.title}`, `  kind: ${issue.kind}`, "  measured:"];
  for (const fact of issue.measured) lines.push(`    - ${fact.label}: ${fact.value}`);
  if (issue.evidence.length > 0) {
    lines.push("  evidence UIProof stored (already measured, do not restate as new conclusions):");
    for (const evidence of issue.evidence) {
      lines.push(`    - [${evidence.kind}] ${evidence.note}${evidence.url ? ` (${evidence.url})` : ""}`);
    }
  }
  return lines.join("\n");
}

function excerptBlock(candidate: SourceCandidate): string {
  const reasons = candidate.via.map((reason) => `      · ${reason}`).join("\n");
  const matched =
    candidate.matchedLines.length > 0 ? candidate.matchedLines.join(", ") : "no line matched directly";
  return [
    `    file: ${candidate.path} (excerpt: lines ${candidate.excerptStartLine}–${candidate.excerptEndLine}${
      candidate.excerptTruncated ? ", file continues" : ""
    })`,
    `      why this file:`,
    reasons,
    `      matched line(s): ${matched}`,
    "      ```",
    candidate.excerpt,
    "      ```",
  ].join("\n");
}

export interface PromptOptions {
  /** Total character budget for the whole prompt. */
  readonly maxChars?: number;
}

export interface PromptBundle {
  readonly system: string;
  readonly user: string;
  readonly chars: number;
  /** Issues that fit inside the budget, in the order they were given. */
  readonly issues: readonly DiagnosticIssue[];
  /** Candidates that fit inside the budget, per issue. */
  readonly candidates: ReadonlyMap<string, readonly SourceCandidate[]>;
  readonly warnings: readonly string[];
}

/**
 * Assembles the prompt, dropping the least useful material first when it does not fit.
 * What was dropped is returned as a warning so the diagnosis can state it.
 */
export function buildPrompt(
  context: DiagnosticContext,
  issues: readonly DiagnosticIssue[],
  candidatesByIssue: ReadonlyMap<string, readonly SourceCandidate[]>,
  options: PromptOptions = {},
): PromptBundle {
  const maxChars = options.maxChars ?? MAX_PROMPT_CHARS;
  const warnings: string[] = [];

  let budget = MAX_CANDIDATE_CHARS;
  const keptCandidates = new Map<string, SourceCandidate[]>();

  for (const issue of issues) {
    const candidates = candidatesByIssue.get(issue.key) ?? [];
    const kept: SourceCandidate[] = [];
    for (const candidate of candidates) {
      const cost = Math.min(candidate.excerpt.length, EXCERPT_CHARS_PER_FILE);
      if (budget - cost < 0) {
        warnings.push(
          `Excerpts for ${issue.key} were dropped to stay inside the prompt budget (${candidate.path} not sent).`,
        );
        break;
      }
      budget -= cost;
      kept.push(candidate);
    }
    keptCandidates.set(issue.key, kept);
  }

  const render = (chosen: readonly DiagnosticIssue[], chosenCandidates: ReadonlyMap<string, readonly SourceCandidate[]>): string => {
    const blocks = chosen.map((issue) => {
      const list = chosenCandidates.get(issue.key) ?? [];
      const sources =
        list.length > 0
          ? list.map(excerptBlock).join("\n")
          : "    (no file in the registered source directory matched this issue's route, selector or text)";
      return `- issue key: ${issue.key}\n${measurableLines(issue)}\n  candidate source files UIProof read (cite only these):\n${sources}`;
    });

    return [
      `UIProof diagnosis request`,
      `Source under test: ${context.sourceLabel}${context.route ? ` at ${context.route}` : ""}`,
      `Scope: ${context.scopeKey}`,
      context.auditId ? `Audit: ${context.auditId}` : `Run: ${context.reportId}`,
      `Measured at: ${context.createdAt}`,
      context.warnings.length > 0
        ? `UIProof's own caveats about this report:\n${context.warnings.map((warning: string) => `  · ${warning}`).join("\n")}`
        : "",
      "",
      `Issues to diagnose (${chosen.length}):`,
      blocks.join("\n\n"),
      "",
      SCHEMA_PROMPT,
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  };

  let chosen = [...issues];
  let user = render(chosen, keptCandidates);

  // If the whole thing still does not fit, drop the least severe issue (the last one) and
  // say so. Nothing is silently truncated mid-excerpt.
  while (chosen.length > 1 && user.length + SYSTEM_PROMPT.length > maxChars) {
    const dropped = chosen[chosen.length - 1];
    chosen = chosen.slice(0, -1);
    warnings.push(`${dropped.key} was not sent: the prompt would have exceeded ${maxChars} characters.`);
    user = render(chosen, keptCandidates);
  }

  return {
    system: SYSTEM_PROMPT,
    user,
    chars: user.length + SYSTEM_PROMPT.length,
    issues: chosen,
    candidates: keptCandidates,
    warnings,
  };
}
