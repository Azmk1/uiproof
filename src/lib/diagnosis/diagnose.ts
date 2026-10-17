import { createHash } from "node:crypto";
import { ComparisonError } from "@/lib/compare/errors";
import { readReport } from "@/lib/compare/storage";
import { readAudit } from "@/lib/quality/storage";
import { DEFAULT_MAX_ISSUES, readModelConfig, requestChatCompletion, type ChatMessage, type EnvLike } from "./client";
import { findCandidates } from "./candidates";
import { buildPrompt } from "./prompt";
import { requireDiagnosable, contextFromAudit, contextFromReport, type DiagnosticContext } from "./context";
import { MAX_MODEL_ISSUES, MAX_SOURCES_PER_ISSUE, validateDiagnosisResponse } from "./schema";
import { diagnosisId, persistDiagnosis } from "./storage";
import type { Diagnosis, DiagnosedIssue } from "./types";
import { openWorkspace } from "./workspace";

/**
 * The diagnosis pipeline, end to end:
 *
 *   stored report → measured issues → registered source directory → candidate excerpts
 *   → one chat completion → strict validation + citation verification → stored diagnosis
 *
 * Three properties are enforced here rather than trusted to a caller:
 *
 *  · **Nothing is written to the source tree.** The only module that touches it has no write
 *    path, and this function passes it read-only metadata.
 *  · **Nothing is diagnosed that was not measured.** A passing run, or a report with no
 *    findings, is refused before a model is contacted.
 *  · **A failure is a failure.** No model, a rejected request, a malformed answer: each
 *    throws, nothing is persisted, and no verdict anywhere changes — a diagnosis has no
 *    verdict to change.
 */

export interface DiagnoseInput {
  /** Exactly one of these two identifies the stored report to explain. */
  readonly reportId?: unknown;
  readonly auditId?: unknown;
  /** Explicit local override (the CLI's `--source`). */
  readonly sourceDir?: unknown;
  /**
   * Looks up the source directory the developer registered for the project that owns the
   * report. It is a callback because only the caller has the registration file: the engine
   * will not guess at a path, and the API never accepts one from a browser.
   */
  readonly lookupRegisteredSource?: (projectId: string | null) => {
    readonly dir: string | null;
    readonly from: string | null;
  };
  readonly maxIssues?: unknown;
  readonly env?: EnvLike;
  readonly fetchImpl?: typeof fetch;
  readonly persist?: boolean;
  readonly cwd?: string;
}

export interface DiagnoseResult {
  readonly diagnosis: Diagnosis;
  /** Absolute path of the stored JSON, or `null` when persistence was skipped. */
  readonly path: string | null;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(MAX_MODEL_ISSUES, Math.floor(parsed));
}

/** Resolves the report to explain, refusing an ambiguous or unknown request. */
async function loadContext(input: DiagnoseInput): Promise<DiagnosticContext> {
  const hasReport = input.reportId !== undefined && input.reportId !== null;
  const hasAudit = input.auditId !== undefined && input.auditId !== null;
  if (hasReport === hasAudit) {
    throw new ComparisonError(
      "invalid_options",
      "A diagnosis needs exactly one stored report: pass a run id or an audit id (not both).",
    );
  }

  if (hasReport) {
    const report = await readReport(input.reportId);
    if (!report) {
      throw new ComparisonError("report_not_found", `No stored run with id ${String(input.reportId)}.`);
    }
    return contextFromReport(report);
  }

  const audit = await readAudit(input.auditId);
  if (!audit) {
    throw new ComparisonError("report_not_found", `No stored audit with id ${String(input.auditId)}.`);
  }
  return contextFromAudit(audit);
}

/** Runs one diagnosis. Throws `ComparisonError` for every failure mode. */
export async function runDiagnosis(input: DiagnoseInput): Promise<DiagnoseResult> {
  const context = await loadContext(input);

  const { config, reason } = readModelConfig(input.env);
  const maxIssues = readPositiveInt(input.maxIssues, config?.maxIssues ?? DEFAULT_MAX_ISSUES);
  const issues = requireDiagnosable(context, maxIssues);

  if (!config) {
    throw new ComparisonError(
      "diagnosis_unavailable",
      reason ?? "No model is configured, so no diagnosis can be produced.",
    );
  }

  const explicitSource = typeof input.sourceDir === "string" && input.sourceDir.trim().length > 0 ? input.sourceDir.trim() : null;
  const registered = input.lookupRegisteredSource?.(context.projectId) ?? { dir: null, from: null };
  const sourceRoot = explicitSource ?? registered.dir ?? null;
  if (!sourceRoot) {
    throw new ComparisonError(
      "diagnosis_source_unregistered",
      registered.from
        ? `Project ${context.projectId ?? "(unknown)"} has no "sourceDir" in ${registered.from}, so UIProof has no application code to investigate. Add one, or pass --source <directory>.`
        : `No application source directory is registered for ${context.scopeKey}. Add "sourceDir" to the project in uiproof.config.json, or pass --source <directory>.`,
    );
  }

  const workspace = await openWorkspace(sourceRoot, input.cwd);
  const { byIssue, filesRead } = await findCandidates(workspace, issues, context.route);
  const prompt = buildPrompt(context, issues, byIssue);

  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];

  const reply = await requestChatCompletion(config, messages, { fetchImpl: input.fetchImpl });
  const validation = validateDiagnosisResponse(reply.content, prompt.issues, prompt.candidates, {
    maxIssues: Math.min(MAX_MODEL_ISSUES, prompt.issues.length),
    maxSourcesPerIssue: MAX_SOURCES_PER_ISSUE,
  });

  // The exact bytes the model was shown, so a later read can tell whether a citation is
  // still pointing at the same code. Reading reuses the workspace's guarded read.
  const snapshot: Record<string, string> = {};
  for (const relativePath of filesRead) {
    const file = workspace.files.find((entry) => entry.relativePath === relativePath);
    if (!file) continue;
    try {
      snapshot[relativePath] = createHash("sha256").update(await workspace.read(file)).digest("hex");
    } catch {
      // A file that could not be re-read is simply absent from the snapshot; the stale
      // check will report it as missing rather than claiming it is current.
    }
  }

  const diagnosed: DiagnosedIssue[] = prompt.issues.map((issue) => ({
    key: issue.key,
    kind: issue.kind,
    title: issue.title,
    measured: issue.measured,
    evidence: issue.evidence,
    diagnosis: validation.diagnoses.get(issue.key) ?? null,
  }));

  const diagnosis: Diagnosis = {
    id: diagnosisId(),
    createdAt: new Date().toISOString(),
    reportId: context.reportId,
    auditId: context.auditId,
    scopeKey: context.scopeKey,
    sourceLabel: context.sourceLabel,
    sourceRoot: workspace.root,
    filesScanned: workspace.files.length,
    filesRead,
    model: {
      provider: "openai-compatible",
      model: config.model,
      endpointHost: config.endpointHost,
      latencyMs: reply.latencyMs,
      promptChars: prompt.chars,
      responseChars: reply.content.length,
      jsonModeFallback: reply.jsonModeFallback,
    },
    issues: diagnosed,
    warnings: [...context.warnings, ...prompt.warnings, ...validation.warnings],
    sourceSnapshot: { files: snapshot },
    aiGenerated: true,
  };

  const path = input.persist === false ? null : await persistDiagnosis(diagnosis);
  return { diagnosis, path };
}
