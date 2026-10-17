import { ComparisonError } from "@/lib/compare/errors";
import type { DiagnosticIssue, ModelDiagnosis, SourceCandidate, UnverifiedSource, VerifiedSource } from "./types";

/**
 * Validates what a model answered, and verifies every source it cited.
 *
 * Two separate jobs, both strict:
 *
 *  · **Shape.** The response must be one JSON object with the documented fields. A missing
 *    field, a wrong type, an over-long string or a confidence that is not one of the three
 *    allowed values refuses the whole response — a partly-read diagnosis is presented as if
 *    it were the model's answer, which is worse than saying "the response was unusable".
 *  · **Citations.** A path is accepted only if UIProof sent that file for that issue, and a
 *    line only if it is inside the excerpt UIProof actually showed. Everything else is kept
 *    as an *unverified* citation, with the reason, so a hallucinated reference is visible
 *    rather than deleted — and can never be mistaken for a verified one.
 *
 * The validator does no I/O: it compares against the candidate metadata that was sent, so
 * "verified" means "this is what the model was shown", which is the only claim that is
 * true by construction.
 */

export const MAX_MODEL_ISSUES = 8;
export const MAX_SOURCES_PER_ISSUE = 8;
export const MAX_CITED_FACTS = 12;

const MAX_SUMMARY = 400;
const MAX_CAUSE = 1500;
const MAX_REPAIR = 1500;
const MAX_UNCERTAINTY = 800;
const MAX_WHY = 300;
const MAX_PATH = 240;
const MAX_FACT_QUOTE = 240;

const CONFIDENCE = ["high", "medium", "low"] as const;

interface Limits {
  readonly maxIssues: number;
  readonly maxSourcesPerIssue: number;
}

const DEFAULT_LIMITS: Limits = { maxIssues: MAX_MODEL_ISSUES, maxSourcesPerIssue: MAX_SOURCES_PER_ISSUE };

function refuse(message: string): never {
  throw new ComparisonError(
    "diagnosis_invalid_response",
    `The model's answer did not match the required shape: ${message}`,
  );
}

/**
 * A response wrapped in a single markdown fence is accepted — providers do it even when
 * asked for JSON — but anything besides that one object is refused.
 */
export function extractJsonObject(raw: string): unknown {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string, where: string, max: number): string {
  const value = source[key];
  if (typeof value !== "string") refuse(`${where}."${key}" must be a string`);
  const text = value.trim();
  if (text.length === 0) refuse(`${where}."${key}" must not be empty`);
  if (text.length > max) refuse(`${where}."${key}" is longer than ${max} characters`);
  return text;
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string, max: number): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") refuse(`${where}."${key}" must be a string or null`);
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > max) refuse(`${where}."${key}" is longer than ${max} characters`);
  return text;
}

/** The line's text exactly as it was sent, or `null` when the line is not in the excerpt. */
function lineFromExcerpt(candidate: SourceCandidate, line: number): string | null {
  const prefix = `${line}: `;
  for (const entry of candidate.excerpt.split("\n")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

function verifySource(
  raw: unknown,
  where: string,
  issueKey: string,
  candidates: readonly SourceCandidate[],
): { verified: VerifiedSource | null; unverified: UnverifiedSource | null } {
  if (!isRecord(raw)) refuse(`${where} must be an object`);
  const path = readString(raw, "path", where, MAX_PATH);
  const why = readString(raw, "why", where, MAX_WHY);

  const lineValue = raw.line;
  let line: number | null = null;
  if (lineValue !== undefined && lineValue !== null) {
    if (typeof lineValue !== "number" || !Number.isInteger(lineValue) || lineValue < 1) {
      refuse(`${where}."line" must be a whole line number of 1 or more, or null`);
    }
    line = lineValue;
  }

  const candidate = candidates.find((entry) => entry.path === path);
  if (!candidate) {
    return {
      verified: null,
      unverified: {
        path,
        line,
        why,
        reason: `UIProof did not read that file for ${issueKey}; only the files listed for the issue can be cited.`,
      },
    };
  }

  if (line === null) {
    return { verified: { path, line: null, why, lineText: null }, unverified: null };
  }

  const lineText = lineFromExcerpt(candidate, line);
  if (lineText === null) {
    return {
      verified: null,
      unverified: {
        path,
        line,
        why,
        reason:
          `line ${line} is outside the excerpt UIProof sent for ${path} ` +
          `(lines ${candidate.excerptStartLine}–${candidate.excerptEndLine}).`,
      },
    };
  }

  return { verified: { path, line, why, lineText }, unverified: null };
}

export interface ValidationResult {
  /** One entry per requested issue; `null` when the model did not answer for it. */
  readonly diagnoses: ReadonlyMap<string, ModelDiagnosis>;
  readonly warnings: readonly string[];
}

/**
 * Validates a raw model answer against the issues that were asked about and the candidates
 * that were shown. Throws `diagnosis_invalid_response` for anything malformed.
 */
export function validateDiagnosisResponse(
  raw: string,
  requested: readonly DiagnosticIssue[],
  candidatesByIssue: ReadonlyMap<string, readonly SourceCandidate[]>,
  limits: Limits = DEFAULT_LIMITS,
): ValidationResult {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) refuse("the top level was not a JSON object");
  const rawIssues = parsed.issues;
  if (!Array.isArray(rawIssues)) refuse('"issues" must be an array');

  const requestedKeys = new Set(requested.map((issue) => issue.key));
  const diagnoses = new Map<string, ModelDiagnosis>();
  const warnings: string[] = [];

  const accepted = rawIssues.slice(0, limits.maxIssues);
  if (rawIssues.length > limits.maxIssues) {
    warnings.push(`${rawIssues.length - limits.maxIssues} extra issue(s) were ignored: at most ${limits.maxIssues} are read.`);
  }

  for (const [index, entry] of accepted.entries()) {
    const where = `issues[${index}]`;
    if (!isRecord(entry)) refuse(`${where} must be an object`);

    const key = readString(entry, "key", where, 300);
    if (!requestedKeys.has(key)) {
      refuse(`${where}."key" is ${JSON.stringify(key)}, which was not one of the issues UIProof sent`);
    }
    if (diagnoses.has(key)) refuse(`${where}."key" repeats ${JSON.stringify(key)}`);

    const confidence = readString(entry, "confidence", where, 10);
    if (!(CONFIDENCE as readonly string[]).includes(confidence)) {
      refuse(`${where}."confidence" must be one of ${CONFIDENCE.join(", ")}`);
    }

    const rawFacts = entry.citedFacts;
    if (!Array.isArray(rawFacts)) refuse(`${where}."citedFacts" must be an array`);
    if (rawFacts.length > MAX_CITED_FACTS) refuse(`${where}."citedFacts" has more than ${MAX_CITED_FACTS} entries`);
    const citedFacts = rawFacts.map((fact, factIndex) => {
      if (typeof fact !== "string") refuse(`${where}."citedFacts[${factIndex}]" must be a string`);
      const text = fact.trim();
      if (text.length === 0) refuse(`${where}."citedFacts[${factIndex}]" must not be empty`);
      if (text.length > MAX_FACT_QUOTE) refuse(`${where}."citedFacts[${factIndex}]" is longer than ${MAX_FACT_QUOTE} characters`);
      return text;
    });

    const rawSources = entry.sources;
    if (!Array.isArray(rawSources)) refuse(`${where}."sources" must be an array`);
    if (rawSources.length > limits.maxSourcesPerIssue) {
      refuse(`${where}."sources" has more than ${limits.maxSourcesPerIssue} entries`);
    }
    const issueCandidates = candidatesByIssue.get(key) ?? [];
    const sources: VerifiedSource[] = [];
    const unverifiedSources: UnverifiedSource[] = [];
    for (const [sourceIndex, source] of rawSources.entries()) {
      const result = verifySource(source, `${where}."sources[${sourceIndex}]"`, key, issueCandidates);
      if (result.verified) sources.push(result.verified);
      if (result.unverified) unverifiedSources.push(result.unverified);
    }
    if (unverifiedSources.length > 0) {
      warnings.push(
        `${unverifiedSources.length} citation(s) in ${key} could not be verified against the excerpts UIProof sent; they are reported as unverified.`,
      );
    }

    diagnoses.set(key, {
      summary: readString(entry, "summary", where, MAX_SUMMARY),
      likelyCause: readString(entry, "likelyCause", where, MAX_CAUSE),
      repairApproach: readString(entry, "repairApproach", where, MAX_REPAIR),
      citedFacts,
      confidence: confidence as ModelDiagnosis["confidence"],
      uncertainty: readOptionalString(entry, "uncertainty", where, MAX_UNCERTAINTY),
      sources,
      unverifiedSources,
    });
  }

  const missing = requested.filter((issue) => !diagnoses.has(issue.key));
  if (missing.length > 0) {
    warnings.push(
      `The model did not return a diagnosis for ${missing.length} issue(s): ${missing.map((issue) => issue.key).join(", ")}.`,
    );
  }

  return { diagnoses, warnings };
}
