import { ComparisonError } from "@/lib/compare/errors";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import { MAX_PATCH_CHARS } from "./patch";

/**
 * Validates the JSON a model returns for a repair proposal.
 *
 * Shape only: this module has no filesystem access and does not decide whether the diff is
 * safe or applies. It refuses anything malformed as a whole, because a half-read proposal
 * presented as the model's answer is worse than an explicit "the answer was unusable".
 * The patch itself is parsed and scoped by `patch.ts` and `preparePatch`.
 */

const MAX_TITLE = 120;
const MAX_SUMMARY = 400;
const MAX_EXPLANATION = 2_000;
const MAX_EXPECTED = 500;
const MAX_UNCERTAINTY = 800;
const CONFIDENCE = ["high", "medium", "low"] as const;

export interface ProposalDraft {
  readonly issueKey: string;
  readonly title: string;
  readonly summary: string;
  readonly explanation: string;
  readonly expectedImprovement: string;
  readonly uncertainty: string | null;
  readonly confidence: "high" | "medium" | "low";
  /** Empty when the model declined to propose a change. */
  readonly patch: string;
}

function refuse(message: string): never {
  throw new ComparisonError(
    "repair_invalid_response",
    `The model's repair proposal did not match the required shape: ${message}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts one bare JSON object, or exactly one fenced block containing it. */
export function extractRepairJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) refuse("the answer was empty");
  let candidate = trimmed;
  if (candidate.startsWith("```")) {
    const firstNewline = candidate.indexOf("\n");
    if (firstNewline === -1) refuse("the answer was a fence with nothing in it");
    const closing = candidate.lastIndexOf("```");
    if (closing <= firstNewline) refuse("the answer was an unterminated code fence");
    if (candidate.slice(closing + 3).trim().length > 0) refuse("the answer had text after the JSON block");
    candidate = candidate.slice(firstNewline + 1, closing).trim();
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch (cause) {
    refuse(`it was not valid JSON (${(cause as Error).message})`);
  }
}

function readString(source: Record<string, unknown>, key: string, max: number, allowEmpty = false): string {
  const value = source[key];
  if (typeof value !== "string") refuse(`"${key}" must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) refuse(`"${key}" must not be empty`);
  if (text.length > max) refuse(`"${key}" is longer than ${max} characters`);
  return text;
}

function readOptionalString(source: Record<string, unknown>, key: string, max: number): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") refuse(`"${key}" must be a string or null`);
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > max) refuse(`"${key}" is longer than ${max} characters`);
  return text;
}

/**
 * Validates one proposal against the issues UIProof asked about. Throws
 * `repair_invalid_response` for anything that is not exactly the documented shape.
 */
export function validateRepairProposal(raw: string, requested: readonly DiagnosticIssue[]): ProposalDraft {
  const parsed = extractRepairJson(raw);
  if (!isRecord(parsed)) refuse("the top level was not a JSON object");

  const issueKey = readString(parsed, "issueKey", 300);
  if (!requested.some((issue) => issue.key === issueKey)) {
    refuse(`"issueKey" is ${JSON.stringify(issueKey)}, which was not one of the issues UIProof sent`);
  }

  const confidence = readString(parsed, "confidence", 10);
  if (!(CONFIDENCE as readonly string[]).includes(confidence)) {
    refuse(`"confidence" must be one of ${CONFIDENCE.join(", ")}`);
  }

  const patch = readString(parsed, "patch", MAX_PATCH_CHARS, true);
  if (patch.length > 0 && !patch.startsWith("---")) {
    refuse('"patch" must be a unified diff beginning with "--- "');
  }

  return {
    issueKey,
    title: readString(parsed, "title", MAX_TITLE),
    summary: readString(parsed, "summary", MAX_SUMMARY),
    explanation: readString(parsed, "explanation", MAX_EXPLANATION),
    expectedImprovement: readString(parsed, "expectedImprovement", MAX_EXPECTED),
    uncertainty: readOptionalString(parsed, "uncertainty", MAX_UNCERTAINTY),
    confidence: confidence as ProposalDraft["confidence"],
    patch,
  };
}
