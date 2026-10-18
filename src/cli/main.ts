import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../../package.json";
import { approveBaseline, listStoredBaselines, readBaselineManifest } from "@/lib/compare/baselines";
import { closeBrowser } from "@/lib/compare/browser";
import { runComparison } from "@/lib/compare/engine";
import { ComparisonError } from "@/lib/compare/errors";
import { formatBytes, formatChangePercentage } from "@/lib/compare/metrics";
import { resolveAuditDir, resolveReportDir } from "@/lib/compare/storage-paths";
import { DEFAULT_VIEWPORT_ID, VIEWPORT_PRESETS, getViewport } from "@/lib/compare/targets";
import type { BaselineScope, ComparisonReport } from "@/lib/compare/types";
import { runQualityAudit } from "@/lib/quality/audit";
import { describePolicy } from "@/lib/quality/policy";
import type { QualityVerdict } from "@/lib/quality/types";
import { runDiagnosis } from "@/lib/diagnosis/diagnose";
import { runRepair } from "@/lib/repair/engine";
import { repairPatchName } from "@/lib/repair/storage";
import type { RepairMeasurement, RepairVerdict } from "@/lib/repair/types";
import { loadProjectCatalog, resolveProjectConfigPath, resolveRegisteredSourceDir } from "@/lib/projects/config";
import { findProject, findRoute } from "@/lib/projects/registry";
import { CLI_NAME, CliUsageError, helpText, parseArgs, type ParsedArgs } from "./args";
import { EXIT_ERROR, EXIT_PASS, EXIT_REGRESSION, type CliExitCode } from "./exit-codes";
import { accessibilitySummaryLine, findingLines } from "./finding-lines";
import { createOutput, type CliOutput } from "./output";
import { exportPortableBaselines, importPortableBaselines } from "./portable";

/**
 * The CLI: UIProof without the dashboard.
 *
 * Everything below calls the same engine the web console calls — `runComparison` for a
 * capture or a drift check, `approveBaseline` to approve, the store's own readers to report
 * status, and the portable-baseline module to move approvals between machines. There is no
 * second implementation of the comparison, the diff, or the manifest rules, and no HTTP
 * server involved: this is what a CI job runs.
 *
 * Exit codes are part of the interface (see `exit-codes.ts` and `--help`): 0 passed or
 * captured, 1 a visual regression, 2 anything that stopped the tool from answering —
 * bad configuration, no approved baseline, no browser, an unreachable application.
 */

export { EXIT_ERROR, EXIT_PASS, EXIT_REGRESSION, type CliExitCode } from "./exit-codes";

export const CLI_VERSION: string = packageJson.version;

/**
 * Where the registration file and the store live for this invocation. The engine reads
 * both through environment variables, so the CLI points them at the resolved paths once,
 * before any command runs, instead of threading them through every call.
 */
export function applyGlobalOptions(parsed: ParsedArgs, cwd: string = process.cwd()): {
  readonly configPath: string;
  readonly storageDir: string | null;
} {
  if (parsed.config) {
    const configPath = path.resolve(cwd, parsed.config);
    process.env.UIPROOF_PROJECTS_FILE = configPath;
  }
  if (parsed.storage) {
    process.env.UIPROOF_DATA_DIR = path.resolve(cwd, parsed.storage);
  }
  return {
    configPath: resolveProjectConfigPath(cwd),
    storageDir: parsed.storage ? path.resolve(cwd, parsed.storage) : null,
  };
}

interface Source {
  readonly projectId: string;
  readonly routeId: string;
  readonly label: string;
  readonly origin: string;
  readonly path: string;
}

/** Resolves `--project`/`--route` against the registration file. */
async function requireSource(parsed: ParsedArgs, io: CliOutput): Promise<Source> {
  const catalog = await loadProjectCatalog();
  if (catalog.error) {
    throw new ComparisonError(
      "project_config_invalid",
      `The registration file could not be used: ${catalog.error}`,
    );
  }
  if (!catalog.configPath) {
    throw new ComparisonError(
      "project_config_invalid",
      `No registration file found at ${resolveProjectConfigPath()}.`,
    );
  }

  if (!parsed.project) throw new CliUsageError("--project <id> is required for capture, check and audit.");
  const project = findProject(catalog.projects, parsed.project);
  if (!project) {
    const known = catalog.projects.map((entry) => entry.id).join(", ") || "none";
    throw new ComparisonError(
      "project_not_registered",
      `Project ${JSON.stringify(parsed.project)} is not registered in ${catalog.configPath} (registered: ${known}).`,
    );
  }
  if (!parsed.route) throw new CliUsageError("--route <id> is required for capture, check and audit.");
  const route = findRoute(project, parsed.route);
  if (!route) {
    const known = project.routes.map((entry) => entry.id).join(", ");
    throw new ComparisonError(
      "route_not_registered",
      `Route ${JSON.stringify(parsed.route)} is not registered for project "${project.id}" (registered: ${known}).`,
    );
  }

  io.note(`${project.name} · ${route.name} — ${project.origin}${route.path}`);
  return {
    projectId: project.id,
    routeId: route.id,
    label: `${project.name} · ${route.name}`,
    origin: project.origin,
    path: route.path,
  };
}

function requireViewport(parsed: ParsedArgs): string {
  const viewportId = parsed.viewport ?? DEFAULT_VIEWPORT_ID;
  if (!getViewport(viewportId)) {
    const known = VIEWPORT_PRESETS.map((preset) => preset.id).join(", ");
    throw new CliUsageError(`Unknown viewport ${JSON.stringify(viewportId)}. Known viewports: ${known}.`);
  }
  return viewportId;
}

/** Runs one capture or drift check through the engine and reports its outcome. */
async function runEngine(
  command: "capture" | "check",
  parsed: ParsedArgs,
  io: CliOutput,
  viewportId: string,
): Promise<ComparisonReport> {
  const source = await requireSource(parsed, io);
  const catalog = await loadProjectCatalog();
  const mode = command === "capture" ? "capture" : "baseline";

  io.note(`${command === "capture" ? "Capturing" : "Checking"} ${source.label} at ${viewportId}…`);
  return runComparison({
    source: { kind: "project", projectId: source.projectId, routeId: source.routeId },
    viewportId,
    mode,
    maxDiffPercent: parsed.tolerance ?? undefined,
    // Only demo sources use this origin, and the CLI never runs a demo target; the
    // engine's own URL builder has no such default.
    origin: "http://127.0.0.1",
    projects: catalog.projects,
    projectConfigError: catalog.error,
    // `--quality` measures the page under test in the same capture; the visual verdict is
    // computed exactly as before and is never influenced by it.
    quality: parsed.quality ? true : undefined,
  });
}

/** Same layout the console reads: <store>/reports/<run id>. */
function reportDirectory(report: ComparisonReport): string {
  return resolveReportDir(report.id);
}

/** The registered project behind a run. Every CLI run has one; a demo run would not. */
function projectScopeOf(report: ComparisonReport): { kind: "project"; projectId: string; routeId: string } {
  const source = report.source;
  if (!source?.projectId || !source.routeId) {
    throw new ComparisonError("invalid_target", "This run is not a registered project route, so the CLI cannot use it.");
  }
  return { kind: "project", projectId: source.projectId, routeId: source.routeId };
}

export async function runCapture(parsed: ParsedArgs, io: CliOutput, viewportId: string): Promise<CliExitCode> {
  const report = await runEngine("capture", parsed, io, viewportId);
  const current = report.artifacts.current;

  const scope = projectScopeOf(report);

  let manifest = null;
  let approved: { id: string } | null = null;
  if (parsed.approve) {
    const result = await approveBaseline({
      scope,
      viewportId,
      sourceReportId: report.id,
      note: parsed.note,
    });
    manifest = result.manifest;
    approved = { id: result.version.id };
    io.note(`Approved ${result.version.id} as the active baseline for this route at ${result.version.viewportLabel}.`);
  } else {
    manifest = await readBaselineManifest(scope, viewportId);
  }

  const hasBaseline = manifest?.activeVersionId !== null && manifest?.activeVersionId !== undefined;
  io.note(
    `Screenshot: ${report.viewport.width}×${report.viewport.height}, ${formatBytes(current.bytes)}, ${report.engine.totalMs} ms`,
  );
  io.note(`Stored in ${reportDirectory(report)}`);
  io.note(
    hasBaseline
      ? `Nothing was compared — a capture is not a pass. Run "${CLI_NAME} check" to compare against the approved baseline.`
      : `Nothing was compared — a capture is not a pass. Approve it with --approve, then "${CLI_NAME} check" detects drift.`,
  );

  io.result({
    command: "capture",
    status: "captured",
    exitCode: EXIT_PASS,
    source: { projectId: scope.projectId, routeId: scope.routeId, viewportId },
    report,
    reportPath: reportDirectory(report),
    render: current.url,
    approved,
    baseline: manifest,
  });
  return EXIT_PASS;
}

export async function runCheck(parsed: ParsedArgs, io: CliOutput, viewportId: string): Promise<CliExitCode> {
  const report = await runEngine("check", parsed, io, viewportId);
  const { metrics } = report;
  const tolerance = metrics.maxDiffPercent;
  const where = `${report.target.label} at ${report.viewport.label}`;

  if (report.status === "captured") {
    throw new ComparisonError(
      "baseline_not_found",
      `No approved baseline exists for ${where}, so there was nothing to compare against.`,
    );
  }

  const regression = report.status === "regression";
  if (regression) {
    io.note(
      `REGRESSION  ${formatChangePercentage(metrics.changePercentage, 4)}% of the viewport changed ` +
        `(${metrics.changedPixels.toLocaleString("en-US")} of ${metrics.comparedPixels.toLocaleString("en-US")} px), ` +
        `above the ${tolerance}% tolerance`,
    );
    io.note(`Reference: ${report.baseline?.versionId ?? "unknown"} · approve with: ${CLI_NAME} capture --approve`);
  } else {
    io.note(
      `PASS  ${formatChangePercentage(metrics.changePercentage, 4)}% of the viewport changed ` +
        `(${metrics.changedPixels} of ${metrics.comparedPixels.toLocaleString("en-US")} px), within the ${tolerance}% tolerance`,
    );
  }
  io.note(`Diff: ${report.artifacts.diff?.url ?? "not generated"} · report: ${reportDirectory(report)}`);

  const scope = projectScopeOf(report);
  io.result({
    command: "check",
    status: report.status,
    exitCode: regression ? EXIT_REGRESSION : EXIT_PASS,
    source: { projectId: scope.projectId, routeId: scope.routeId, viewportId },
    tolerance,
    baseline: report.baseline ?? null,
    report,
    reportPath: reportDirectory(report),
    diff: report.artifacts.diff ?? null,
  });
  return regression ? EXIT_REGRESSION : EXIT_PASS;
}

function auditVerdictLine(verdict: QualityVerdict): string {
  if (verdict.status === "pass") return "QUALITY PASS";
  return "QUALITY FAIL";
}

/**
 * `uiproof audit` — accessibility and responsive layout, judged by policy.
 *
 * Exit 1 means the policy failed: severe accessibility violations or layout escaping the
 * viewport past the configured limits. It never approves, replaces or touches a visual
 * baseline — a failing quality gate is a report, not a mutation.
 */
export async function runAudit(parsed: ParsedArgs, io: CliOutput): Promise<CliExitCode> {
  const source = await requireSource(parsed, io);
  const catalog = await loadProjectCatalog();

  const viewports = parsed.viewport ? [requireViewport(parsed)] : VIEWPORT_PRESETS.map((preset) => preset.id);
  const policy: Record<string, unknown> = {};
  if (parsed.failOn !== null) policy.failOn = parsed.failOn;
  if (parsed.newOnly) policy.failOnNewOnly = true;
  if (parsed.wcagOnly) policy.includeBestPractice = false;
  if (parsed.maxDocumentOverflow !== null) policy.maxDocumentOverflowPx = parsed.maxDocumentOverflow;
  if (parsed.maxElementOverflow !== null) policy.maxElementOverflowPx = parsed.maxElementOverflow;

  io.note(`Auditing ${source.label} at ${viewports.join(", ")}…`);

  const { report, reportPath } = await runQualityAudit({
    source: { kind: "project", projectId: source.projectId, routeId: source.routeId },
    viewports,
    policy: Object.keys(policy).length > 0 ? policy : undefined,
    origin: "http://127.0.0.1",
    projects: catalog.projects,
    projectConfigError: catalog.error,
  });

  io.note(`Policy: ${describePolicy(report.policy)}`);
  io.note(
    `Runner: ${report.engine.axeVersion} (${report.engine.ruleSets.join(", ")}) · ${report.engine.browser} · ${report.engine.totalMs} ms`,
  );

  for (const viewport of report.viewports) {
    const { accessibility, responsive } = viewport;
    io.note("");
    io.note(`${viewport.viewport.label} (${viewport.viewport.width}×${viewport.viewport.height}):`);
    io.note(`  accessibility — ${accessibilitySummaryLine(accessibility)}`);
    for (const finding of accessibility.findings) {
      for (const line of findingLines(finding)) io.note(line);
    }
    if (accessibility.truncated) {
      io.note(
        `  (showing ${accessibility.findings.length} of ${accessibility.totalFindings} findings; the verdict evaluated all ${accessibility.totalFindings})`,
      );
    }
    io.note(
      `  responsive — document scrolls ${responsive.documentOverflowPx}px horizontally`,
    );
    for (const finding of responsive.findings) {
      io.note(
        `    ${finding.selector} escapes the viewport by ${finding.overflowPx}px (${finding.kind})`,
      );
      if (finding.html) io.note(`        ${finding.html}`);
    }
    if (responsive.truncated) {
      io.note(
        `  (showing ${responsive.findings.length} of ${responsive.defects.length} layout defects; the verdict evaluated all ${responsive.defects.length})`,
      );
    }
    for (const finding of responsive.contained) {
      io.note(
        `    ${finding.selector} overflows ${finding.overflowPx}px inside a scrollable region (${finding.scrollContainer ?? "scroller"}) — not a defect`,
      );
    }
  }

  io.note("");
  io.note(auditVerdictLine(report.verdict));
  for (const failure of report.verdict.failures) {
    io.note(`  ${failure.code} — ${failure.message}`);
  }
  for (const note of report.verdict.notes) io.note(`  note: ${note}`);

  if (report.references.length > 0) {
    io.note(
      `Reference: ${report.references.map((reference) => `${reference.versionId} (${reference.viewportId})`).join(", ")}`,
    );
    const covered = new Set(report.references.map((reference) => reference.viewportId));
    const uncovered = report.viewports
      .map((viewport) => viewport.viewport.id)
      .filter((viewportId) => !covered.has(viewportId));
    if (uncovered.length > 0) {
      io.note(
        `  no approved accessibility snapshot for ${uncovered.join(", ")} — findings measured there count as new.`,
      );
    }
    io.note(
      `  accessibility against the reference — new ${report.newFindingFingerprints.length}, ` +
        `known ${report.knownFindingFingerprints.length}, resolved ${report.resolvedFindingFingerprints.length}`,
    );
  } else {
    io.note("Reference: none — no approved baseline carries an accessibility snapshot for this route, so every finding counts.");
  }

  // The report's own `reportPath` is store-relative (the API serves it that way); the
  // transcript prints the directory a person can actually open.
  if (reportPath) {
    io.note(`Evidence: ${resolveAuditDir(report.id)} (audit.json + one screenshot per viewport)`);
  }

  const exitCode = report.verdict.status === "fail" ? EXIT_REGRESSION : EXIT_PASS;
  io.result({
    command: "audit",
    status: report.verdict.status,
    exitCode,
    source: { projectId: source.projectId, routeId: source.routeId, viewports },
    policy: report.policy,
    verdict: report.verdict,
    references: report.references,
    newFindingFingerprints: report.newFindingFingerprints,
    knownFindingFingerprints: report.knownFindingFingerprints,
    resolvedFindingFingerprints: report.resolvedFindingFingerprints,
    report,
    reportPath,
  });
  return exitCode;
}

/**
 * `uiproof diagnose` — an evidence-grounded explanation of a stored report.
 *
 * Exit `0` means a diagnosis was produced and stored. It never returns `1`: a diagnosis is
 * an explanation, not a verdict, and nothing here can change the verdict of the report it
 * explains. Without a configured model (or without a registered source directory) it exits
 * `2` and writes nothing.
 */
export async function runDiagnose(parsed: ParsedArgs, io: CliOutput, cwd: string): Promise<CliExitCode> {
  if (!parsed.report && !parsed.audit) {
    throw new CliUsageError("diagnose needs --report <run id> (a comparison) or --audit <audit id>.");
  }
  if (parsed.report && parsed.audit) {
    throw new CliUsageError("diagnose explains one report at a time: pass --report or --audit, not both.");
  }

  const catalog = await loadProjectCatalog();
  io.note(`Diagnosing ${parsed.audit ? `audit ${parsed.audit}` : `run ${parsed.report}`}…`);

  const { diagnosis, path: storedPath } = await runDiagnosis({
    reportId: parsed.report ?? undefined,
    auditId: parsed.audit ?? undefined,
    sourceDir: parsed.source ?? undefined,
    lookupRegisteredSource: (projectId) => {
      const project = projectId ? findProject(catalog.projects, projectId) : undefined;
      return {
        dir: project ? resolveRegisteredSourceDir(project, catalog.configPath) : null,
        from: catalog.configPath,
      };
    },
    maxIssues: parsed.maxIssues ?? undefined,
    cwd,
  });

  io.note(
    `${diagnosis.sourceLabel} · model ${diagnosis.model.model} @ ${diagnosis.model.endpointHost} ` +
      `(${diagnosis.model.latencyMs} ms, ${diagnosis.model.promptChars} prompt characters)`,
  );
  io.note(
    `Source: ${diagnosis.sourceRoot} — ${diagnosis.filesScanned} file(s) listed, ` +
      `${diagnosis.filesRead.length} read for this diagnosis`,
  );

  for (const issue of diagnosis.issues) {
    io.note("");
    io.note(issue.title);
    for (const fact of issue.measured) io.note(`  measured ${fact.label}: ${fact.value}`);
    const answer = issue.diagnosis;
    if (!answer) {
      io.note("  the model did not diagnose this issue");
      continue;
    }
    io.note(`  model (confidence ${answer.confidence}): ${answer.summary}`);
    io.note(`  likely cause: ${answer.likelyCause}`);
    io.note(`  suggested approach: ${answer.repairApproach}`);
    if (answer.uncertainty) io.note(`  uncertainty: ${answer.uncertainty}`);
    for (const source of answer.sources) {
      io.note(`  source (verified): ${source.path}${source.line === null ? "" : `:${source.line}`} — ${source.why}`);
    }
    for (const source of answer.unverifiedSources) {
      io.note(
        `  citation NOT verified: ${source.path}${source.line === null ? "" : `:${source.line}`} — ${source.reason}`,
      );
    }
  }

  io.note("");
  for (const warning of diagnosis.warnings) io.note(`  note: ${warning}`);
  if (storedPath) io.note(`Stored in ${storedPath}`);
  io.note("A diagnosis is a model-generated explanation, never a measurement — no verdict changes because of it.");

  io.result({
    command: "diagnose",
    status: "diagnosed",
    exitCode: EXIT_PASS,
    scopeKey: diagnosis.scopeKey,
    reportId: diagnosis.reportId,
    auditId: diagnosis.auditId,
    model: diagnosis.model,
    sourceRoot: diagnosis.sourceRoot,
    filesScanned: diagnosis.filesScanned,
    filesRead: diagnosis.filesRead,
    diagnosis,
    path: storedPath,
  });
  return EXIT_PASS;
}

function verdictLine(verdict: RepairVerdict): string {
  switch (verdict) {
    case "verified":
      return "REPAIR VERIFIED";
    case "partially-improved":
      return "REPAIR PARTIALLY IMPROVED";
    case "rejected":
      return "REPAIR REJECTED";
    default:
      return "REPAIR NOT VERIFIABLE";
  }
}

function measurementLine(measurement: RepairMeasurement): string {
  return measurement.pages
    .map((page) => {
      const a11y = `${page.accessibility.violations} violation(s), ${page.accessibility.serious + page.accessibility.critical} serious/critical`;
      const layout = `${page.layout.documentOverflowPx}px overflow`;
      const visual = page.visual.status === "no-baseline" ? "no baseline" : `${page.visual.changePercentage}% vs baseline`;
      return `${page.routeId}@${page.viewportId}: ${a11y}, ${layout}, ${visual}`;
    })
    .join(" · ");
}

/**
 * `uiproof repair` — propose a patch, apply it only inside an isolated copy, measure both
 * sides with the real audit engine, and report a deterministic verdict.
 *
 * Exit `0` only when a patch is verified. It never writes to the source tree, never
 * approves a baseline and never merges anything: `--out` writes a standalone patch file a
 * developer can review and apply by hand.
 */
export async function runRepairCommand(parsed: ParsedArgs, io: CliOutput, cwd: string): Promise<CliExitCode> {
  if (!parsed.report && !parsed.audit) {
    throw new CliUsageError("repair needs --report <run id> (a comparison) or --audit <audit id>.");
  }
  if (parsed.report && parsed.audit) {
    throw new CliUsageError("repair works on one report at a time: pass --report or --audit, not both.");
  }

  const catalog = await loadProjectCatalog();
  io.note(
    `Repairing ${parsed.audit ? `audit ${parsed.audit}` : `run ${parsed.report}`}${parsed.maxAttempts ? ` (up to ${parsed.maxAttempts} attempt(s))` : ""}…`,
  );

  const { repair, path: storedPath, sandboxPath } = await runRepair({
    reportId: parsed.report ?? undefined,
    auditId: parsed.audit ?? undefined,
    sourceDir: parsed.source ?? undefined,
    maxAttempts: parsed.maxAttempts ?? undefined,
    keepSandbox: parsed.keepSandbox,
    cwd,
    lookupProject: (projectId) => {
      const project = projectId ? findProject(catalog.projects, projectId) : undefined;
      return {
        project: project ?? null,
        sourceDir: project ? resolveRegisteredSourceDir(project, catalog.configPath) : null,
        from: catalog.configPath,
      };
    },
  });

  io.note(
    `Source: ${repair.sourceRoot} — revision ${repair.revision.commitSha ?? "(no Git repository)"}` +
      `${repair.revision.dirty === true ? ` with ${repair.revision.dirtyFiles.length} uncommitted path(s)` : ""}, ` +
      `${repair.revision.digestFiles} file(s) pinned`,
  );
  io.note(`Model: ${repair.model?.model ?? "none"} @ ${repair.model?.endpointHost ?? "-"}`);
  io.note(`Execution: ${repair.execution.summary}`);
  io.note(`Sandbox: ${repair.limits.maxAttempts} attempt(s) maximum, ${repair.before.pages.length} page(s) measured`);
  if (repair.execution.mode === "host") {
    io.note("  WARNING: host execution is a filesystem copy, not an OS security boundary.");
  }

  for (const [index, attempt] of repair.attempts.entries()) {
    io.note("");
    io.note(`Attempt ${attempt.attempt} of ${repair.limits.maxAttempts}: ${verdictLine(attempt.verdict)}`);
    if (attempt.proposal) {
      io.note(`  target: ${attempt.proposal.issueKey} — ${attempt.proposal.title}`);
      io.note(`  change: ${attempt.proposal.summary}`);
      io.note(
        `  files: ${attempt.proposal.files.map((file) => `${file.path} (+${file.additions}/-${file.deletions})`).join(", ")}`,
      );
      io.note(`  expected: ${attempt.proposal.expectedImprovement}`);
      if (attempt.proposal.uncertainty) io.note(`  uncertainty: ${attempt.proposal.uncertainty}`);
      io.note("  diff:");
      for (const line of attempt.proposal.patch.split("\n").slice(0, 80)) io.note(`    ${line}`);
      if (attempt.proposal.patch.split("\n").length > 80) io.note("    …");
    }
    if (attempt.rejection) io.note(`  refused: ${attempt.rejection}`);
    if (attempt.verification) {
      const verification = attempt.verification;
      io.note(`  before: ${measurementLine(verification.before)}`);
      if (verification.after) io.note(`  after:  ${measurementLine(verification.after)}`);
      for (const target of verification.targets) {
        io.note(`  ${target.status.toUpperCase()} ${target.issueKey}: ${target.before} → ${target.after}`);
      }
      for (const command of verification.build) {
        io.note(`  ${command.name}: ${command.status}${command.reason ? ` (${command.reason})` : ""}`);
      }
      for (const reason of verification.reasons) io.note(`  why: ${reason}`);
      for (const note of verification.notes) io.note(`  note: ${note}`);
    }
    if (index === repair.attempts.length - 1 && attempt.durationMs > 0) {
      io.note(`  duration: ${attempt.durationMs} ms`);
    }
  }

  io.note("");
  io.note(verdictLine(repair.status));
  for (const warning of repair.warnings) io.note(`  note: ${warning}`);
  if (repair.originalUnchanged) {
    io.note(`  the original source is unchanged (digest ${repair.revision.digest.slice(0, 12)}… before and after)`);
  } else {
    io.note("  WARNING: the original source changed during the run; the patch was not applied by UIProof, but re-check the tree.");
  }
  if (storedPath) io.note(`Stored in ${storedPath}`);
  if (sandboxPath) io.note(`Sandbox kept at ${sandboxPath}`);

  let exported: string | null = null;
  const verified = repair.attempts.find((attempt) => attempt.verdict === "verified") ?? null;
  if (parsed.out) {
    if (!verified) {
      io.note(`No verified patch to export: ${CLI_NAME} only exports a patch a measurement accepted.`);
    } else {
      exported = path.resolve(cwd, parsed.out);
      await writeFile(exported, verified.proposal?.patch.endsWith("\n") ? verified.proposal.patch : `${verified.proposal?.patch ?? ""}\n`, "utf8");
      io.note(`Verified patch exported to ${exported}`);
    }
  }
  if (verified?.patchArtifact) {
    io.note(`Patch artifact: ${verified.patchArtifact} (also downloadable from the dashboard)`);
  }
  if (repair.status !== "verified") {
    io.note("Nothing was merged, committed or approved. The working tree is exactly as it was.");
  }

  const exitCode = repair.status === "verified" ? EXIT_PASS : EXIT_REGRESSION;
  io.result({
    command: "repair",
    status: repair.status,
    exitCode,
    scopeKey: repair.target.scopeKey,
    reportId: repair.target.kind === "report" ? repair.target.id : null,
    auditId: repair.target.kind === "audit" ? repair.target.id : null,
    revision: repair.revision,
    revisionAfter: repair.revisionAfter,
    execution: repair.execution,
    originalUnchanged: repair.originalUnchanged,
    verifiedAttempt: repair.verifiedAttempt,
    attempts: repair.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      verdict: attempt.verdict,
      rejection: attempt.rejection,
      proposal: attempt.proposal,
      verification: attempt.verification,
      patchArtifact: attempt.patchArtifact ? repairPatchName(attempt.attempt) : null,
    })),
    repair,
    path: storedPath,
    sandboxPath,
    exportedPatch: exported,
  });
  return exitCode;
}

export async function runProjects(_parsed: ParsedArgs, io: CliOutput): Promise<CliExitCode> {
  const catalog = await loadProjectCatalog();
  if (catalog.error) {
    throw new ComparisonError("project_config_invalid", `The registration file could not be used: ${catalog.error}`);
  }

  if (!catalog.configPath) {
    io.note(`No registration file found at ${resolveProjectConfigPath()}.`);
    io.note("Create one (see examples/uiproof.config.example.json) or pass --config <file>.");
  } else if (catalog.projects.length === 0) {
    io.note(`No projects are registered in ${catalog.configPath}.`);
  } else {
    io.note(`${catalog.projects.length} project(s) in ${catalog.configPath}`);
    for (const project of catalog.projects) {
      io.note(`  ${project.id} — ${project.name} (${project.origin})`);
      for (const route of project.routes) {
        io.note(`      ${route.id.padEnd(16)} ${route.path}${route.name ? `  ·  ${route.name}` : ""}`);
      }
    }
  }

  io.result({
    command: "projects",
    exitCode: EXIT_PASS,
    configPath: catalog.configPath ?? resolveProjectConfigPath(),
    configError: catalog.error,
    projects: catalog.projects,
  });
  return EXIT_PASS;
}

interface BaselineSelection {
  readonly projectId: string | null;
  readonly routeId: string | null;
  readonly viewportId: string | null;
  readonly all: boolean;
}

function selectionOf(parsed: ParsedArgs, viewportId: string | null): BaselineSelection {
  return {
    projectId: parsed.project,
    routeId: parsed.route,
    viewportId,
    all: parsed.all,
  };
}

function scopeKey(scope: BaselineScope): string {
  return scope.kind === "demo" ? `demo:${scope.targetId}` : `project:${scope.projectId}/${scope.routeId}`;
}

export async function runBaselinesStatus(
  parsed: ParsedArgs,
  io: CliOutput,
  viewportId: string | null,
): Promise<CliExitCode> {
  const stored = (await listStoredBaselines()).filter((entry) => {
    const selection = selectionOf(parsed, viewportId);
    if (selection.viewportId && entry.viewportId !== selection.viewportId) return false;
    if (!selection.all && selection.projectId) {
      if (entry.scope.kind !== "project" || entry.scope.projectId !== selection.projectId) return false;
      if (selection.routeId && entry.scope.routeId !== selection.routeId) return false;
    }
    return true;
  });

  if (stored.length === 0) {
    io.note("No approved baselines on this machine yet.");
    io.note(`Capture one with: ${CLI_NAME} capture --project <id> --route <id> --approve`);
  }

  for (const entry of stored) {
    const active = entry.manifest.versions.find((version) => version.id === entry.manifest.activeVersionId) ?? null;
    io.note(
      `${scopeKey(entry.scope)} @ ${entry.viewportId} — ${entry.manifest.versions.length} version(s), ` +
        `${active ? `active ${active.id} (${active.width}×${active.height}, from run ${active.sourceReportId})` : "nothing active"}`,
    );
    for (const version of entry.manifest.versions) {
      io.note(
        `    ${version.id}${version.id === entry.manifest.activeVersionId ? " (active)" : ""}  ` +
          `${version.approvedAt}  ${version.capturedRoute}  ${formatBytes(version.bytes)}`,
      );
    }
  }

  io.result({
    command: "baselines",
    exitCode: EXIT_PASS,
    storage: process.env.UIPROOF_DATA_DIR ?? null,
    baselines: stored.map((entry) => ({
      scope: entry.scope,
      scopeKey: scopeKey(entry.scope),
      viewportId: entry.viewportId,
      targetLabel: entry.manifest.targetLabel,
      activeVersionId: entry.manifest.activeVersionId,
      revision: entry.manifest.revision,
      versions: entry.manifest.versions,
    })),
  });
  return EXIT_PASS;
}

export async function runBaselinesExport(parsed: ParsedArgs, io: CliOutput, viewportId: string | null): Promise<CliExitCode> {
  const selection = selectionOf(parsed, viewportId);
  if (!selection.all && !selection.projectId) {
    throw new CliUsageError("baselines export needs --project <id> (optionally with --route) or --all.");
  }
  const out = path.resolve(parsed.out ?? path.join(process.cwd(), "uiproof-baselines"));

  const result = await exportPortableBaselines({
    out,
    selection,
    generator: `${CLI_NAME} ${CLI_VERSION}`,
  });

  io.note(
    `Exported ${result.versions} approved version(s) across ${result.scopes} scope(s) to ${result.manifestPath} (${formatBytes(result.bytes)} of PNGs).`,
  );
  io.note("Commit the bundle (or upload it as a CI artifact) and import it on a clean machine with `baselines import --activate`.");

  io.result({
    command: "baselines export",
    exitCode: EXIT_PASS,
    out,
    manifestPath: result.manifestPath,
    scopes: result.scopes,
    versions: result.versions,
    bytes: result.bytes,
  });
  return EXIT_PASS;
}

export async function runBaselinesImport(parsed: ParsedArgs, io: CliOutput, viewportId: string | null): Promise<CliExitCode> {
  if (!parsed.from) throw new CliUsageError("baselines import needs --from <bundle directory>.");
  const from = path.resolve(parsed.from);

  const result = await importPortableBaselines({
    from,
    selection: selectionOf(parsed, viewportId),
    activate: parsed.activate,
  });

  for (const entry of result.scopes) {
    io.note(
      `${scopeKey(entry.scope)} @ ${entry.viewportId} — added ${entry.added}, already present ${entry.alreadyPresent}, ` +
        `${entry.activeVersionId ? `active ${entry.activeVersionId}` : "nothing active"}`,
    );
  }
  io.note(
    result.accessibilitySnapshots > 0
      ? `${result.accessibilitySnapshots} version(s) carried an accessibility snapshot; --new-only can now compare against them.`
      : "No version in this bundle carries an accessibility snapshot, so audits here still treat every finding as new.",
  );
  if (result.added > 0 && !parsed.activate) {
    io.note("Imported versions are stored but not active. Pass --activate to make the bundle's baseline the reference.");
  }

  io.result({
    command: "baselines import",
    exitCode: EXIT_PASS,
    from,
    activated: parsed.activate,
    added: result.added,
    alreadyPresent: result.alreadyPresent,
    accessibilitySnapshots: result.accessibilitySnapshots,
    scopes: result.scopes.map((entry) => ({
      scope: entry.scope,
      scopeKey: scopeKey(entry.scope),
      viewportId: entry.viewportId,
      added: entry.added,
      alreadyPresent: entry.alreadyPresent,
      activeVersionId: entry.activeVersionId,
      activeMismatch: entry.activeMismatch,
    })),
  });
  return EXIT_PASS;
}

function describeFailure(error: unknown): { message: string; hint: string | null; code: string } {
  if (error instanceof CliUsageError) {
    return { message: error.message, hint: `Run "${CLI_NAME} --help" to see the options.`, code: "usage_error" };
  }
  if (error instanceof ComparisonError) {
    const hints: Partial<Record<ComparisonError["code"], string>> = {
      baseline_not_found: `Create the reference first: ${CLI_NAME} capture --project <id> --route <id> --approve`,
      project_config_invalid:
        "See examples/uiproof.config.example.json for the expected shape, or pass --config <file>.",
      browser_unavailable: "Install Chromium with `pnpm setup:browser`.",
      baseline_version_conflict: "Approved versions are immutable; import a different bundle or clean the store deliberately.",
      portable_bundle_invalid: "Re-export the bundle with `baselines export`.",
      baseline_integrity_failed: "Re-export the bundle; the images in it are not what the metadata claims.",
      diagnosis_unavailable:
        "AI diagnosis is optional: set UIPROOF_AI_API_KEY (and optionally UIPROOF_AI_BASE_URL, UIPROOF_AI_MODEL) to enable it. Everything else keeps working without it.",
      diagnosis_source_unregistered:
        'Add "sourceDir" to the project in the registration file, or pass --source <directory>.',
      diagnosis_source_invalid: "Check that the source directory exists and is the application you registered.",
      diagnosis_invalid_response: "The model's answer was unusable; nothing was stored and no verdict changed.",
      repair_unavailable:
        'A repair needs a configured model and a "repair" block (sandbox, build, test and execution) in the project registration. ' +
        'Container execution is the default; "mode": "host" additionally needs "trustHostExecution": true.',
      repair_source_unregistered:
        'Register "sourceDir" on the project, or pass --source <directory>; a repair never guesses at a source tree.',
      repair_source_invalid: "Check that the source directory exists and is the application you registered.",
      repair_source_changed:
        "The tree changed while it was being copied. Stop editing the application and run the repair again.",
      repair_nothing_to_repair: "The report has no measured defect to repair.",
      repair_invalid_response: "The model's answer was unusable; the attempt was recorded and no file was changed.",
      repair_patch_rejected: "The proposed diff did not apply exactly to the pinned source, so it was refused.",
      repair_scope_violation:
        "The proposed diff touched a path a repair may not modify (a secret, dependency, generated file, CI policy or baseline).",
      repair_limits_exceeded: "The proposal was larger than the patch limits; no file was changed.",
      repair_sandbox_failed:
        "The isolated copy could not be started. Check the repair.sandbox command, its url and that the port is free.",
      repair_measurement_failed:
        "The candidate could not be measured, so it was not described as repaired. Check the application still serves.",
    };
    return { message: error.message, hint: hints[error.code] ?? null, code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, hint: null, code: "internal_error" };
}

/** Runs one command line and returns its exit code. Never throws. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<CliExitCode> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const io = createOutput({ json: argv.includes("--json"), quiet: false });
    const failure = describeFailure(error);
    io.warn(`${CLI_NAME}: ${failure.message}`);
    if (failure.hint) io.warn(failure.hint);
    io.result({ command: "usage", status: "error", exitCode: EXIT_ERROR, error: failure });
    return EXIT_ERROR;
  }

  if (parsed.help) {
    process.stdout.write(helpText(CLI_VERSION));
    return EXIT_PASS;
  }
  if (parsed.command === "version") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return EXIT_PASS;
  }

  const io = createOutput({ json: parsed.json, quiet: parsed.quiet });
  applyGlobalOptions(parsed, cwd);

  try {
    // Resolved inside the guard: an unknown --viewport is a usage error the user must see
    // as exit code 2 with a message, not as an unhandled exception.
    const viewportId = parsed.viewport ? requireViewport(parsed) : DEFAULT_VIEWPORT_ID;
    const baselineViewport = parsed.viewport ? viewportId : null;

    switch (parsed.command) {
      case "capture":
        return await runCapture(parsed, io, viewportId);
      case "check":
        return await runCheck(parsed, io, viewportId);
      case "audit":
        return await runAudit(parsed, io);
      case "diagnose":
        return await runDiagnose(parsed, io, cwd);
      case "repair":
        return await runRepairCommand(parsed, io, cwd);
      case "projects":
        return await runProjects(parsed, io);
      case "baselines":
        if (parsed.subcommand === "export") return await runBaselinesExport(parsed, io, baselineViewport);
        if (parsed.subcommand === "import") return await runBaselinesImport(parsed, io, baselineViewport);
        return await runBaselinesStatus(parsed, io, baselineViewport);
      default:
        process.stdout.write(helpText(CLI_VERSION));
        return EXIT_PASS;
    }
  } catch (error) {
    const failure = describeFailure(error);
    io.warn(`${CLI_NAME}: ${failure.message}`);
    if (failure.hint) io.warn(failure.hint);
    io.result({ command: parsed.command, status: "error", exitCode: EXIT_ERROR, error: failure });
    return EXIT_ERROR;
  } finally {
    // The engine shares one Chromium instance and closes it when idle, which is right for
    // a server. This process runs one command and exits, so it shuts the browser down
    // itself instead of leaving the event loop alive until the idle timer fires.
    await closeBrowser();
  }
}

// Run only when executed directly (the bundled CLI), never when imported by a test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
