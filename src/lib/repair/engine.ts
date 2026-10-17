import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";
import { readReport } from "@/lib/compare/storage";
import { DEFAULT_PIXEL_THRESHOLD } from "@/lib/compare/metrics";
import { getViewport, VIEWPORT_PRESETS } from "@/lib/compare/targets";
import type { RegisteredProject, ViewportPreset } from "@/lib/compare/types";
import { DEFAULT_MAX_ISSUES, readModelConfig, requestChatCompletion, type ChatMessage, type EnvLike } from "@/lib/diagnosis/client";
import { findCandidates } from "@/lib/diagnosis/candidates";
import { contextFromAudit, contextFromReport, requireDiagnosable, type DiagnosticContext } from "@/lib/diagnosis/context";
import { openWorkspace, type Workspace } from "@/lib/diagnosis/workspace";
import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import { readAudit } from "@/lib/quality/storage";
import { routesToMeasure } from "./config";
import { measureSandbox, type MeasureRoute, type MeasurementImage } from "./measure";
import { MAX_PATCH_FILES, MAX_PATCH_LINES, preparePatch } from "./patch";
import { buildRepairPrompt, MAX_PROMPT_FILE_CHARS, MAX_REPAIR_PROMPT_CHARS, type RepairPromptFile } from "./prompt";
import { validateRepairProposal } from "./proposal";
import { digestFileMap, readGitRevision } from "./revision";
import {
  createSandboxCopy,
  runSandboxCommand,
  startSandboxServer,
  writeSandboxFile,
  type RunningSandboxServer,
} from "./sandbox";
import { persistRepair, repairId, repairPatchName, reasonOf } from "./storage";
import type {
  RepairArtifact,
  RepairAttempt,
  RepairMeasurement,
  RepairModelInfo,
  RepairProposal,
  RepairRun,
  RepairSummary,
  RepairVerification,
  SandboxCommandResult,
  SourceRevision,
} from "./types";
import { verifyRepair } from "./verify";

/**
 * The repair engine, end to end:
 *
 *   stored failure → measured issues → pinned revision → isolated copy → before measurement
 *   → model proposal → strict diff validation → patch applied inside the copy → build/test
 *   → after measurement → deterministic verdict → stored evidence → sandbox deleted
 *
 * The properties the phase brief asks for, enforced here rather than described:
 *
 *  · **The original tree is never written.** The only writes go to a temporary copy, and
 *    the source digest and Git state are captured before and after to prove it.
 *  · **A patch is data, not code.** It is parsed and applied in memory by `patch.ts`, then
 *    written as file contents. No model-supplied string is ever executed.
 *  · **Measurement decides.** The model's claims are stored beside the verdict, never
 *    inside it. A patch the model calls a success is rejected if any measured check fails.
 *  · **Bounded.** At most two attempts, one proposal each, capped prompt/patch size, a
 *    command timeout and a run budget. There is no retry loop.
 */

export const MAX_REPAIR_ATTEMPTS = 2;
export const DEFAULT_REPAIR_ATTEMPTS = 2;
const COMMAND_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

export interface RegisteredProjectLookup {
  readonly project: RegisteredProject | null;
  /** Absolute source directory, already resolved against the registration file. */
  readonly sourceDir: string | null;
  /** Where the registration came from, for an actionable error. */
  readonly from: string | null;
}

export interface RepairEngineInput {
  readonly reportId?: unknown;
  readonly auditId?: unknown;
  /** Explicit local override (the CLI's `--source`). */
  readonly sourceDir?: unknown;
  readonly lookupProject?: (projectId: string | null) => RegisteredProjectLookup;
  readonly maxAttempts?: unknown;
  readonly env?: EnvLike;
  readonly fetchImpl?: typeof fetch;
  readonly persist?: boolean;
  readonly cwd?: string;
  /** Keep the temporary checkout after the run. Only for debugging; defaults to false. */
  readonly keepSandbox?: boolean;
  readonly now?: () => Date;
}

export interface RepairEngineResult {
  readonly repair: RepairRun;
  readonly path: string | null;
  readonly summary: RepairSummary;
  /** Where the sandbox was, when the caller asked to keep it. */
  readonly sandboxPath: string | null;
}

interface LoadedTarget {
  readonly context: DiagnosticContext;
  readonly overflowLimitPx: number;
  readonly tolerance: number;
  readonly pixelThreshold: number;
  readonly viewports: readonly string[];
}

async function loadTarget(input: RepairEngineInput): Promise<LoadedTarget> {
  const hasReport = input.reportId !== undefined && input.reportId !== null;
  const hasAudit = input.auditId !== undefined && input.auditId !== null;
  if (hasReport === hasAudit) {
    throw new ComparisonError(
      "invalid_options",
      "A repair needs exactly one stored report: pass a run id or an audit id (not both).",
    );
  }

  if (hasReport) {
    const report = await readReport(input.reportId);
    if (!report) {
      throw new ComparisonError("report_not_found", `No stored run with id ${String(input.reportId)}.`);
    }
    return {
      context: contextFromReport(report),
      overflowLimitPx: report.quality?.policy.maxDocumentOverflowPx ?? 1,
      tolerance: report.metrics.maxDiffPercent,
      pixelThreshold: report.metrics.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD,
      viewports: [report.viewport.id],
    };
  }

  const audit = await readAudit(input.auditId);
  if (!audit) {
    throw new ComparisonError("report_not_found", `No stored audit with id ${String(input.auditId)}.`);
  }
  return {
    context: contextFromAudit(audit),
    overflowLimitPx: audit.policy.maxDocumentOverflowPx,
    tolerance: 0.1,
    pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
    viewports: audit.viewports.map((entry) => entry.viewport.id),
  };
}

function readAttempts(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_REPAIR_ATTEMPTS;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ComparisonError("invalid_options", "--max-attempts must be 1 or 2.");
  }
  return Math.min(MAX_REPAIR_ATTEMPTS, Math.floor(parsed));
}

function viewports(ids: readonly string[]): ViewportPreset[] {
  const presets: ViewportPreset[] = [];
  for (const id of ids) {
    const preset = getViewport(id);
    if (preset && !presets.includes(preset)) presets.push(preset);
  }
  return presets;
}

/** Reads every source file once; the map is both the patch base and the pinned digest. */
async function readSource(workspace: Workspace): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of workspace.files) contents.set(file.relativePath, await workspace.read(file));
  return contents;
}

/**
 * Files the model may patch: the whole text of the most relevant candidates. A file that
 * does not fit the prompt budget is not shown, and a file that is not shown cannot be
 * patched — the scope check uses exactly this list.
 */
async function promptFiles(
  workspace: Workspace,
  contents: ReadonlyMap<string, string>,
  issues: readonly DiagnosticIssue[],
  route: string | null,
  entryFiles: readonly string[],
): Promise<{ files: RepairPromptFile[]; warnings: string[] }> {
  const byPath = new Map<string, RepairPromptFile>();
  for (const issue of issues) {
    const { byIssue } = await findCandidates(workspace, [issue], route, { maxFiles: 2, excerptLines: 30 });
    for (const candidate of byIssue.get(issue.key) ?? []) {
      if (byPath.has(candidate.path)) continue;
      const text = contents.get(candidate.path);
      if (text === undefined) continue;
      const truncated = text.length > MAX_PROMPT_FILE_CHARS;
      byPath.set(candidate.path, {
        path: candidate.path,
        content: truncated ? text.slice(0, MAX_PROMPT_FILE_CHARS) : text,
        truncated,
        why: candidate.via,
      });
      if (byPath.size >= 4) break;
    }
    if (byPath.size >= 4) break;
  }

  // A visual regression has no selector or page text to search for, so the project's
  // explicitly registered entry files are what the model may patch. Never guessed.
  for (const relativePath of entryFiles) {
    if (byPath.size >= 4) break;
    if (byPath.has(relativePath)) continue;
    const text = contents.get(relativePath);
    if (text === undefined) {
      continue;
    }
    const truncated = text.length > MAX_PROMPT_FILE_CHARS;
    byPath.set(relativePath, {
      path: relativePath,
      content: truncated ? text.slice(0, MAX_PROMPT_FILE_CHARS) : text,
      truncated,
      why: ["registered as a repair entry file for issues with no textual hint"],
    });
  }

  const files = [...byPath.values()];
  const warnings: string[] = [];
  if (files.length === 0) {
    warnings.push(
      "No source file in the registered directory matched the measured issue, so the model had nothing to patch.",
    );
  }
  for (const file of files) {
    if (file.truncated) {
      warnings.push(`${file.path} is longer than ${MAX_PROMPT_FILE_CHARS} characters and was not fully shown, so it cannot be patched.`);
    }
  }
  return { files, warnings };
}

function artifactsOf(
  repairIdValue: string,
  images: readonly MeasurementImage[],
): RepairArtifact[] {
  return images.map((image) => ({
    name: image.name,
    kind: image.kind,
    phase: image.phase,
    routeId: image.routeId,
    viewportId: image.viewportId,
    bytes: image.buffer.byteLength,
    url: `/api/repairs/${encodeURIComponent(repairIdValue)}/artifacts/${encodeURIComponent(image.name)}`,
  }));
}

async function runConfigured(
  name: "build" | "test",
  command: readonly string[] | null,
  cwd: string,
): Promise<SandboxCommandResult> {
  if (!command) {
    return {
      name,
      command: [],
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      outputTail: "",
      reason: `No repair ${name} command is registered, so it could not be checked.`,
    };
  }
  const outcome = await runSandboxCommand({ command, cwd, timeoutMs: COMMAND_TIMEOUT_MS });
  return {
    name,
    command,
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    outputTail: outcome.outputTail,
    reason: outcome.reason,
  };
}

/** Runs one measurement pass with a fresh server, stopping it afterwards no matter what. */
async function measureOnce(
  server: () => Promise<RunningSandboxServer>,
  measure: (url: string) => Promise<{ measurement: RepairMeasurement; images: readonly MeasurementImage[] }>,
): Promise<{ measurement: RepairMeasurement; images: readonly MeasurementImage[]; serverLog: string }> {
  const running = await server();
  try {
    const result = await measure(running.url);
    return { ...result, serverLog: running.log() };
  } finally {
    await running.stop();
  }
}

/**
 * Runs one repair. Configuration failures throw; an attempt that could not be measured is
 * recorded as an attempt with an `unverified` verdict rather than being hidden.
 */
export async function runRepair(input: RepairEngineInput): Promise<RepairEngineResult> {
  const target = await loadTarget(input);
  const { context } = target;
  const issues = requireDiagnosable(context, DEFAULT_MAX_ISSUES);
  const maxAttempts = readAttempts(input.maxAttempts);
  const now = () => (input.now?.() ?? new Date()).toISOString();

  const { config: modelConfig, reason: modelReason } = readModelConfig(input.env);
  if (!modelConfig) {
    throw new ComparisonError("repair_unavailable", modelReason ?? "No model is configured, so no repair can be proposed.");
  }

  const lookup = input.lookupProject?.(context.projectId) ?? { project: null, sourceDir: null, from: null };
  if (!lookup.project) {
    throw new ComparisonError(
      "repair_source_unregistered",
      `Repair needs a registered project route. ${context.scopeKey} is not one, so there is no source directory UIProof may copy.`,
    );
  }
  const project = lookup.project;
  const repairConfig = project.repair ?? null;
  if (!repairConfig) {
    throw new ComparisonError(
      "repair_unavailable",
      `Project "${project.id}" has no "repair" block in ${lookup.from ?? "uiproof.config.json"}, so no sandbox, build or test command is registered.`,
    );
  }
  const explicitSource =
    typeof input.sourceDir === "string" && input.sourceDir.trim().length > 0 ? input.sourceDir.trim() : null;
  const sourceRoot = explicitSource ?? lookup.sourceDir;
  if (!sourceRoot) {
    throw new ComparisonError(
      "repair_source_unregistered",
      `Project "${project.id}" has no "sourceDir" in ${lookup.from ?? "uiproof.config.json"}, so UIProof has nothing to copy.`,
    );
  }

  const targetRoute = project.routes.find((route) => context.route !== null && route.path === context.route) ?? null;
  if (!targetRoute) {
    throw new ComparisonError(
      "route_not_registered",
      `The report's route (${context.route ?? "unknown"}) is not registered in project "${project.id}", so a repair cannot measure it.`,
    );
  }

  const workspace = await openWorkspace(sourceRoot, input.cwd);
  const contents = await readSource(workspace);
  const digest = digestFileMap(contents);
  const gitState = await readGitRevision(workspace.root);
  const revision: SourceRevision = {
    commitSha: gitState.commitSha,
    dirty: gitState.dirty,
    dirtyFiles: gitState.dirtyFiles,
    capturedAt: now(),
    sourceRoot: workspace.root,
    digest: digest.digest,
    digestFiles: digest.files.size,
  };

  const requested = routesToMeasure(project, targetRoute.id, repairConfig);
  const desktop = getViewport("desktop") ?? VIEWPORT_PRESETS[0];
  const measures: MeasureRoute[] = requested.map((route) => ({
    route,
    viewports:
      route.id === targetRoute.id
        ? viewports(target.viewports.length > 0 ? target.viewports : [desktop.id])
        : [desktop],
    tolerance: route.id === targetRoute.id ? target.tolerance : 0.1,
  }));

  const id = repairId();
  const sandboxDir = path.join(os.tmpdir(), "uiproof-repair", id);
  const warnings: string[] = [];
  if (gitState.reason) warnings.push(gitState.reason);
  if (gitState.dirty === true) {
    warnings.push(
      "The source tree had uncommitted changes when the sandbox was copied. The copy is pinned to those bytes; the commit SHA alone does not reproduce it.",
    );
  }

  const prompt = await promptFiles(workspace, contents, issues, context.route, repairConfig.entryFiles);
  warnings.push(...prompt.warnings);
  const patchable = prompt.files.filter((file) => !file.truncated).map((file) => file.path);

  let baseline: RepairMeasurement | null = null;
  let baselineImages: readonly MeasurementImage[] = [];
  let baselineCommands: readonly SandboxCommandResult[] = [];
  const attempts: RepairAttempt[] = [];
  const patches: Record<string, string> = {};
  const afterImages: MeasurementImage[] = [];
  let sandboxPath: string | null = null;
  let server: RunningSandboxServer | null = null;
  const startedAt = Date.now();

  const startServer = () => startSandboxServer({
    command: repairConfig.sandbox.command,
    cwd: sandboxDir,
    url: repairConfig.sandbox.url,
    readyPath: repairConfig.sandbox.readyPath,
    env: repairConfig.sandbox.env,
  });

  try {
    const copy = await createSandboxCopy(workspace.root, sandboxDir);
    sandboxPath = input.keepSandbox ? copy.root : null;
    for (const skipped of copy.skipped.slice(0, 6)) {
      warnings.push(`Not copied into the sandbox: ${skipped.path} (${skipped.reason}).`);
    }

    // Prove the copy holds exactly the pinned source before any patch exists.
    const copyWorkspace = await openWorkspace(copy.root);
    const copyContents = await readSource(copyWorkspace);
    const copyDigest = digestFileMap(copyContents);
    if (copyDigest.digest !== digest.digest) {
      throw new ComparisonError(
        "repair_source_changed",
        "The source directory changed while the sandbox was being copied, so no repair was attempted. Re-run when the tree is stable.",
      );
    }

    baselineCommands = [
      await runConfigured("build", repairConfig.build, sandboxDir),
      await runConfigured("test", repairConfig.test, sandboxDir),
    ];
    for (const command of baselineCommands) {
      if (command.status === "failed") {
        warnings.push(`The unmodified source already fails its ${command.name} command; a repair cannot claim to keep it passing.`);
      }
    }

    const before = await measureOnce(
      () => {
        return startServer().then((running) => {
          server = running;
          return running;
        });
      },
      async (url) => {
        const result = await measureSandbox({
          project,
          sandboxUrl: url,
          routes: measures,
          phase: "before",
          uiProofOrigin: "http://127.0.0.1",
          policy: undefined,
          pixelThreshold: target.pixelThreshold,
          now,
        });
        return result;
      },
    );
    server = null;
    baseline = before.measurement;
    baselineImages = before.images;
    warnings.push(...before.measurement.warnings);

    // Restore all patchable files to their pinned bytes; used before every attempt.
    const reset = async (): Promise<void> => {
      for (const file of patchable) {
        await writeSandboxFile(sandboxDir, file, contents.get(file) ?? "");
      }
    };

    let previous: RepairAttempt | null = null;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const attemptStarted = Date.now();
      const attemptImages: MeasurementImage[] = [];
      let attempt: RepairAttempt = {
        attempt: attemptNumber,
        createdAt: now(),
        durationMs: 0,
        proposal: null,
        model: null,
        rejection: null,
        patchArtifact: null,
        artifacts: [],
        verification: null,
        verdict: "unverified",
      };

      let patchArtifactRef: string | null = null;
      let modelRef: RepairModelInfo | null = null;
      let proposalRef: RepairProposal | null = null;

      if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
        warnings.push(`The run budget of ${RUN_TIMEOUT_MS} ms was exhausted before attempt ${attemptNumber}.`);
        break;
      }

      try {
        await reset();

        const bundle = buildRepairPrompt({
          context,
          issues,
          files: prompt.files.filter((file) => !file.truncated),
          previous,
        });
        warnings.push(...bundle.warnings);
        const messages: ChatMessage[] = [
          { role: "system", content: bundle.system },
          { role: "user", content: bundle.user },
        ];

        let reply;
        try {
          reply = await requestChatCompletion(modelConfig, messages, { fetchImpl: input.fetchImpl });
        } catch (cause) {
          attempt = {
            ...attempt,
            rejection: (cause as Error).message,
            model: null,
            verdict: "unverified",
            durationMs: Date.now() - attemptStarted,
          };
          attempts.push(attempt);
          break;
        }

        const model: RepairModelInfo = {
          provider: "openai-compatible",
          model: modelConfig.model,
          endpointHost: modelConfig.endpointHost,
          latencyMs: reply.latencyMs,
          promptChars: bundle.chars,
          responseChars: reply.content.length,
          jsonModeFallback: reply.jsonModeFallback,
          revision: previous !== null,
        };
        modelRef = model;

        let draft;
        try {
          draft = validateRepairProposal(reply.content, issues);
        } catch (cause) {
          const rejection = (cause as Error).message;
          attempt = {
            ...attempt,
            model,
            rejection,
            verdict: "unverified",
            durationMs: Date.now() - attemptStarted,
          };
          attempts.push(attempt);
          previous = attempt;
          continue;
        }

        if (draft.patch.length === 0) {
          attempt = {
            ...attempt,
            model,
            rejection: `The model declined to propose a patch: ${draft.uncertainty ?? "no reason given"}`,
            verdict: "unverified",
            durationMs: Date.now() - attemptStarted,
          };
          attempts.push(attempt);
          previous = attempt;
          continue;
        }

        const patchArtifact = repairPatchName(attemptNumber);
        patches[patchArtifact] = draft.patch;
        patchArtifactRef = patchArtifact;
        const issue = issues.find((entry) => entry.key === draft.issueKey) ?? issues[0];
        let prepared;
        try {
          prepared = preparePatch({
            patch: draft.patch,
            files: contents,
            knownFiles: patchable,
            allow: repairConfig.allow,
            limits: { maxFiles: MAX_PATCH_FILES, maxLines: MAX_PATCH_LINES },
          });
        } catch (cause) {
          const error = cause as ComparisonError;
          attempt = {
            ...attempt,
            model,
            rejection: error.message,
            patchArtifact,
            verdict: "rejected",
            durationMs: Date.now() - attemptStarted,
          };
          attempts.push(attempt);
          previous = attempt;
          continue;
        }

        const proposal: RepairProposal = {
          issueKey: draft.issueKey,
          title: draft.title,
          summary: draft.summary,
          explanation: draft.explanation,
          expectedImprovement: draft.expectedImprovement,
          uncertainty: draft.uncertainty,
          confidence: draft.confidence,
          patch: draft.patch,
          files: prepared.applied.changes,
          linesChanged: prepared.parsed.additions + prepared.parsed.deletions,
          applied: true,
        };
        proposalRef = proposal;
        for (const change of prepared.applied.changes) {
          await writeSandboxFile(sandboxDir, change.path, prepared.applied.files.get(change.path) ?? "");
        }

        const afterCommands = [
          await runConfigured("build", repairConfig.build, sandboxDir),
          await runConfigured("test", repairConfig.test, sandboxDir),
        ];

        let after: { measurement: RepairMeasurement; images: readonly MeasurementImage[] } | null = null;
        try {
          after = await measureOnce(
            () => {
              return startServer().then((running) => {
                server = running;
                return running;
              });
            },
            async (url) => {
              const result = await measureSandbox({
                project,
                sandboxUrl: url,
                routes: measures,
                phase: "after",
                namePrefix: `attempt-${attemptNumber}-`,
                uiProofOrigin: "http://127.0.0.1",
                policy: undefined,
                pixelThreshold: target.pixelThreshold,
                now,
              });
              return result;
            },
          );
          server = null;
          attemptImages.push(...after.images);
          warnings.push(...after.measurement.warnings);
        } catch (cause) {
          warnings.push(`Attempt ${attemptNumber} could not be measured: ${(cause as Error).message}`);
        }

        const scope = {
          ok: true,
          files: proposal.files.map((file) => file.path),
          violations: [],
        };
        const verification: RepairVerification = verifyRepair({
          targetIssues: [issue],
          targetRoutePath: context.route,
          before: baseline,
          after: after?.measurement ?? null,
          scope,
          build: [...afterCommands],
          baselineBuild: baselineCommands,
          overflowLimitPx: target.overflowLimitPx,
          pixelTolerance: measures.find((entry) => entry.route.id === targetRoute.id)?.tolerance,
        });

        attempt = {
          attempt: attemptNumber,
          createdAt: attempt.createdAt,
          durationMs: Date.now() - attemptStarted,
          proposal,
          model,
          rejection: null,
          patchArtifact,
          artifacts: artifactsOf(id, attemptImages),
          verification,
          verdict: verification.verdict,
        };
        attempts.push(attempt);
        afterImages.push(...attemptImages);
        previous = attempt;

        if (verification.verdict === "verified") break;
      } catch (cause) {
        // An infrastructure failure is an attempt with no verdict, never a crash that
        // loses the evidence collected so far.
        attempt = {
          ...attempt,
          durationMs: Date.now() - attemptStarted,
          proposal: proposalRef,
          model: modelRef,
          patchArtifact: patchArtifactRef,
          rejection: (cause as Error).message,
          verdict: "unverified",
        };
        attempts.push(attempt);
        previous = attempt;
        if (!(cause instanceof ComparisonError)) throw cause;
      }
    }
  } finally {
    if (server) await server.stop().catch(() => undefined);
    if (!input.keepSandbox) await rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!baseline) {
    throw new ComparisonError(
      "repair_measurement_failed",
      "The unmodified sandbox could not be measured, so no repair could be compared against it.",
    );
  }

  const verified = attempts.find((entry) => entry.verdict === "verified") ?? null;
  const last = attempts.at(-1) ?? null;
  const status = verified ? "verified" : (last?.verdict ?? "unverified");
  const afterDigest = digestFileMap(await readSource(await openWorkspace(workspace.root)));
  const afterGit = await readGitRevision(workspace.root);
  const revisionAfter = {
    commitSha: afterGit.commitSha,
    dirty: afterGit.dirty,
    digest: afterDigest.digest,
    unchanged:
      afterDigest.digest === revision.digest &&
      afterGit.commitSha === revision.commitSha &&
      afterGit.dirty === revision.dirty,
  };
  if (!revisionAfter.unchanged) {
    warnings.push(
      "The original source directory changed during the run. The repair itself only wrote to its sandbox, but the pinned revision no longer matches the tree.",
    );
  }

  const repair: RepairRun = {
    id,
    createdAt: now(),
    target: {
      kind: context.auditId ? "audit" : "report",
      id: context.auditId ?? context.reportId ?? "",
      scopeKey: context.scopeKey,
      label: context.sourceLabel,
      route: context.route,
    },
    projectId: project.id,
    projectName: project.name,
    sourceLabel: context.sourceLabel,
    sourceRoot: workspace.root,
    revision,
    revisionAfter,
    before: baseline,
    baselineArtifacts: artifactsOf(id, baselineImages),
    baselineCommands,
    attempts,
    status,
    verifiedAttempt: verified?.attempt ?? null,
    limits: {
      maxAttempts,
      maxPatchFiles: MAX_PATCH_FILES,
      maxPatchLines: MAX_PATCH_LINES,
      maxPromptChars: MAX_REPAIR_PROMPT_CHARS,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      runTimeoutMs: RUN_TIMEOUT_MS,
    },
    model: {
      provider: "openai-compatible",
      model: modelConfig.model,
      endpointHost: modelConfig.endpointHost,
    },
    warnings: [...new Set(warnings)],
    aiGenerated: true,
    originalUnchanged: revisionAfter.unchanged,
  };

  const storedPath =
    input.persist === false
      ? null
      : await persistRepair({ repair, patches, images: [...baselineImages, ...afterImages] });

  return {
    repair,
    path: storedPath,
    summary: {
      id: repair.id,
      createdAt: repair.createdAt,
      targetKind: repair.target.kind,
      targetId: repair.target.id,
      scopeKey: repair.target.scopeKey,
      sourceLabel: repair.sourceLabel,
      status: repair.status,
      attempts: repair.attempts.length,
      verifiedAttempt: repair.verifiedAttempt,
      commitSha: repair.revision.commitSha,
      originalUnchanged: repair.originalUnchanged,
      reason: reasonOf(repair),
    },
    sandboxPath,
  };
}
