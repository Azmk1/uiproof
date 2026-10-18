import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approveBaseline } from "@/lib/compare/baselines";
import { runComparison } from "@/lib/compare/engine";
import type { RegisteredProject, ViewportPreset } from "@/lib/compare/types";
import { issuesFromQualityReport } from "@/lib/diagnosis/context";
import { readModelConfig } from "@/lib/diagnosis/client";
import { runQualityAudit } from "@/lib/quality/audit";
import { createRepairExecutor, executionConfig, probeContainerRuntime, type RepairExecutor } from "@/lib/repair/container";
import { runRepair } from "@/lib/repair/engine";
import type { RepairRun } from "@/lib/repair/types";
import { getViewport } from "@/lib/compare/targets";
import { offeredIssueKeys, proposalJson, replaceLinePatch, startStubModel, type StubModel } from "../e2e/support/stub-model";

/**
 * The repair benchmark: ten realistic defects, three independent applications, the whole
 * loop for each one.
 *
 * What it measures is the pipeline's behaviour against real defects — a missing accessible
 * name, a contrast failure, a fixed-width banner, a drifted page, in an HTML fixture, a Vite
 * application and a Next.js application — not a model's eloquence. Each run is recorded
 * with its verdict, attempts, duration and prompt/response size, and the report says which
 * model produced the patches.
 *
 * **The distinction this file must never blur.** With no `UIPROOF_AI_API_KEY` the patches
 * come from the deterministic stub in `e2e/support/stub-model.ts`, which answers with the
 * reference fix from `benchmark/defects.json`. That proves the harness and the pipeline; it
 * measures nothing about a model. With a key, every scenario runs against the configured
 * OpenAI-compatible endpoint and the results are the model's.
 *
 * Run it with `pnpm benchmark`. It is deliberately not part of `pnpm verify`: ten repairs
 * against three applications is a long run, and a benchmark is a thing you choose to run.
 */

interface FixtureDefinition {
  readonly directory: string;
  readonly image: string;
  readonly dependenciesVolume: string | null;
  readonly install: readonly string[] | null;
  readonly sandbox: readonly string[];
  readonly readyPath: string;
  readonly build: readonly string[];
  readonly test: readonly string[];
  readonly allow: readonly string[];
  readonly guardPaths: Readonly<Record<string, string>>;
}

interface Scenario {
  readonly id: string;
  readonly fixture: keyof typeof FIXTURES & string;
  readonly category: "accessibility" | "responsive" | "visual";
  readonly target: "audit" | "report";
  readonly routeId: string;
  readonly routePath: string;
  readonly viewports: readonly string[];
  readonly issuePrefix: string;
  readonly guardRoutes: readonly string[];
  readonly patch:
    | { readonly file: string; readonly oldLine: string; readonly newLines: readonly string[] }
    | { readonly file: string; readonly replaceWithSourceFile: string };
  readonly note: string;
}

const FIXTURES: Record<string, FixtureDefinition> = {
  "repair-app": {
    directory: path.join("examples", "repair-app"),
    image: "node:24-bookworm-slim",
    dependenciesVolume: null,
    install: null,
    sandbox: ["node", "server.mjs"],
    readyPath: "/healthz",
    build: ["node", "scripts/check-build.mjs"],
    test: ["node", "scripts/check-tests.mjs"],
    allow: ["views/**"],
    guardPaths: { manual: "/manual" },
  },
  "vite-app": {
    directory: path.join("examples", "vite-app"),
    image: "node:24-bookworm-slim",
    dependenciesVolume: "uiproof-e2e-vite-app-deps",
    install: ["npm", "ci", "--no-audit", "--no-fund"],
    sandbox: ["npm", "run", "start"],
    readyPath: "/",
    build: ["npm", "run", "build"],
    test: ["npm", "test"],
    allow: ["src/**", "styles/**"],
    guardPaths: { settings: "/settings", home: "/", inbox: "/inbox" },
  },
  "next-app": {
    directory: path.join("examples", "next-app"),
    image: "node:24-bookworm-slim",
    dependenciesVolume: "uiproof-e2e-next-app-deps",
    install: ["npm", "ci", "--no-audit", "--no-fund"],
    sandbox: ["npm", "run", "start"],
    readyPath: "/",
    build: ["npm", "run", "build"],
    test: ["npm", "test"],
    allow: ["app/**", "styles/**"],
    guardPaths: { settings: "/settings", home: "/", ledger: "/ledger" },
  },
};

interface ScenarioResult {
  readonly id: string;
  readonly fixture: string;
  readonly category: string;
  readonly issue: string | null;
  readonly verdict: string;
  /** Where the winning attempt's commands actually ran. A verdict from a host run is not an isolated one. */
  readonly executionMode: "container" | "host" | null;
  readonly execution: string | null;
  readonly attempts: number;
  readonly verifiedAtAttempt: number | null;
  /** What the pipeline said about each attempt, in the pipeline's own words. */
  readonly verdicts: readonly {
    readonly attempt: number;
    readonly verdict: string;
    readonly reasons: readonly string[];
    readonly targets: readonly { readonly issueKey: string; readonly status: string; readonly before: string; readonly after: string }[];
    readonly regressions: readonly { readonly kind: string; readonly id: string; readonly status: string; readonly detail: string }[];
  }[];
  readonly rejections: readonly string[];
  readonly durationMs: number;
  readonly promptChars: number;
  readonly responseChars: number;
  readonly estimatedPromptTokens: number;
  readonly estimatedResponseTokens: number;
  readonly error: string | null;
  readonly warnings: readonly string[];
}

const manifest = JSON.parse(await readFile(path.join(process.cwd(), "benchmark", "defects.json"), "utf8")) as {
  scenarios: readonly Scenario[];
};

/**
 * `UIPROOF_BENCHMARK_SCENARIOS=a,b` runs a subset: re-running one defect after changing the
 * prompt, or timing a single fixture, should not cost a full sweep. The report names the
 * ids that were requested, so a partial run can never be mistaken for a whole one.
 */
const requestedIds = (process.env.UIPROOF_BENCHMARK_SCENARIOS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const unknownIds = requestedIds.filter((id) => !manifest.scenarios.some((scenario) => scenario.id === id));
if (unknownIds.length > 0) throw new Error(`Unknown benchmark scenario id(s): ${unknownIds.join(", ")}`);
const scenarios = requestedIds.length > 0 ? manifest.scenarios.filter((scenario) => requestedIds.includes(scenario.id)) : manifest.scenarios;

const configured = readModelConfig(process.env);
const live = configured.config !== null;
const stubModelChosen = live ? null : "stub";
const reportedModel = live ? (configured.config?.model ?? "unknown") : stubModelChosen;

const probe = await probeContainerRuntime({ refresh: true }).catch(() => null);
const dockerAvailable = probe?.available === true;
const skipReason = dockerAvailable ? "" : (probe?.reason ?? "no container runtime answered");

/** Price estimate, only when the operator supplies one. Reported as an estimate, never as a bill. */
const pricePerMillionTokens = Number.parseFloat(process.env.UIPROOF_BENCHMARK_PRICE_PER_MTOK ?? "");
const priceKnown = Number.isFinite(pricePerMillionTokens) && pricePerMillionTokens > 0;

const results: ScenarioResult[] = [];
const cleanups: Array<() => Promise<void>> = [];
let dataDir = "";
let previousDataDir: string | undefined;

async function stopServers(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
}

function projectFor(input: {
  readonly scenario: Scenario;
  readonly fixture: FixtureDefinition;
  readonly sourceDir: string;
  readonly origin: string;
  readonly sandboxPort: number;
}): RegisteredProject {
  const { scenario, fixture } = input;
  const routes = [
    { id: scenario.routeId, name: scenario.routeId, path: scenario.routePath, url: `${input.origin}${scenario.routePath}` },
    ...scenario.guardRoutes
      .filter((id) => id !== scenario.routeId)
      .map((id) => {
        const routePath = fixture.guardPaths[id];
        if (!routePath) throw new Error(`${scenario.id}: no path registered for guard route ${id}`);
        return { id, name: id, path: routePath, url: `${input.origin}${routePath}` };
      }),
  ];

  return {
    id: scenario.fixture,
    name: scenario.fixture,
    origin: input.origin,
    routes,
    modes: ["capture", "baseline"],
    defaultMode: "capture",
    allowedOrigins: [],
    sourceDir: input.sourceDir,
    repair: {
      sandbox: {
        command: [...fixture.sandbox],
        url: `http://127.0.0.1:${input.sandboxPort}`,
        readyPath: fixture.readyPath,
        // Both spellings: Vite reads HOST, Next.js reads HOSTNAME, and a fixture should not
        // have to care which tool UIProof is holding.
        env: { PORT: String(input.sandboxPort), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" },
      },
      build: [...fixture.build],
      test: [...fixture.test],
      allow: [...fixture.allow],
      guardRoutes: [...scenario.guardRoutes],
      entryFiles: [scenario.patch.file],
      execution: executionConfig({
        image: fixture.image,
        network: "none",
        dependenciesVolume: fixture.dependenciesVolume,
        install: fixture.install ? [...fixture.install] : null,
      }),
    },
  };
}

/** The reference fix, as the stub would write it: what the pipeline is measured against. */
function referencePatch(scenario: Scenario, sourceDir: string): Promise<string> {
  return (async () => {
    if ("replaceWithSourceFile" in scenario.patch) {
      const target = path.join(sourceDir, scenario.patch.file);
      const wanted = await readFile(path.join(sourceDir, scenario.patch.replaceWithSourceFile), "utf8");
      const current = await readFile(target, "utf8");
      // The patch applier counts lines the way an editor does: a trailing newline ends the
      // last line, it does not start an empty one. Splitting on "\n" and keeping the empty
      // tail would claim one line too many and the hunk would run off the end of the file.
      const oldLines = current.replace(/\n$/, "").split("\n");
      const newLines = wanted.replace(/\n$/, "").split("\n");
      return [
        `--- a/${scenario.patch.file}`,
        `+++ b/${scenario.patch.file}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join("\n");
    }
    const content = await readFile(path.join(sourceDir, scenario.patch.file), "utf8");
    return replaceLinePatch(scenario.patch.file, content, scenario.patch.oldLine, scenario.patch.newLines);
  })();
}

async function runScenario(scenario: Scenario, index: number): Promise<ScenarioResult> {
  const fixture = FIXTURES[scenario.fixture];
  const started = Date.now();
  const sandboxPort = 4400 + index;
  let stub: StubModel | null = null;
  let executor: RepairExecutor | null = null;
  let workDir = "";
  let sourceDir = "";
  let sandboxDir = "";
  let helperDir = "";
  let repair: RepairRun | null = null;
  let failure: string | null = null;

  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), `uiproof-bench-${scenario.id}-`));
    sourceDir = path.join(workDir, "source");
    sandboxDir = path.join(workDir, "sandbox");
    helperDir = path.join(workDir, "relay");
    await cp(path.join(process.cwd(), fixture.directory), sourceDir, { recursive: true });
    await cp(sourceDir, sandboxDir, { recursive: true });

    executor = await createRepairExecutor({
      config: executionConfig({
        image: fixture.image,
        network: "none",
        dependenciesVolume: fixture.dependenciesVolume,
        install: fixture.install ? [...fixture.install] : null,
      }),
      sandboxDir,
      helperDir,
      runId: `bench${index}`,
    });

    // The visual scenario needs an approved baseline it can then drift away from.
    if (scenario.target === "report") {
      await cp(path.join(sourceDir, "views", "visual.good.html"), path.join(sourceDir, "views", "index.html"));
      await cp(path.join(sourceDir, "views", "visual.good.html"), path.join(sandboxDir, "views", "index.html"));
    }

    // The application's own build, so its own server can run.
    const built = await executor.runCommand({ name: "build", command: [...fixture.build], timeoutMs: 15 * 60_000 });
    if (built.status !== "passed") throw new Error(`${scenario.id}: the fixture's build failed\n${built.outputTail}`);

    const origin = `http://127.0.0.1:${sandboxPort}`;
    const server = await executor.startServer({
      command: [...fixture.sandbox],
      url: origin,
      readyPath: fixture.readyPath,
      env: { PORT: String(sandboxPort), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" },
    });
    cleanups.push(async () => {
      await server.stop().catch(() => undefined);
      if (!live) await rm(helperDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const project = projectFor({ scenario, fixture, sourceDir, origin, sandboxPort });
    const viewports = scenario.viewports as readonly ViewportPreset["id"][];

    let target: { auditId?: string; reportId?: string };

    if (scenario.target === "audit") {
      const { report: audit } = await runQualityAudit({
        source: { kind: "project", projectId: project.id, routeId: scenario.routeId },
        viewports: [...viewports],
        origin: "http://127.0.0.1",
        projects: [project],
        persist: true,
      });
      const { issues } = issuesFromQualityReport(audit);
      const issue = issues.find((entry) => entry.key.startsWith(scenario.issuePrefix));
      if (!issue) {
        throw new Error(
          `${scenario.id}: the audit did not measure ${scenario.issuePrefix} (measured: ${issues.map((entry) => entry.key).join(", ") || "nothing"})`,
        );
      }
      target = { auditId: audit.id };
    } else {
      const viewport = getViewport(viewports[0] ?? "desktop");
      if (!viewport) throw new Error(`${scenario.id}: unknown viewport`);
      const approval = await runComparison({
        source: { kind: "project", projectId: project.id, routeId: scenario.routeId },
        mode: "capture",
        viewportId: viewport.id,
        origin: "http://127.0.0.1",
        projects: [project],
      });
      await approveBaseline({
        scope: { kind: "project", projectId: project.id, routeId: scenario.routeId },
        viewportId: viewport.id,
        sourceReportId: approval.id,
        note: "benchmark baseline",
      });

      // Drift the page away from the approval: the defect the repair has to remove.
      await cp(path.join(sourceDir, "views", "visual.broken.html"), path.join(sourceDir, "views", "index.html"));
      await cp(path.join(sourceDir, "views", "visual.broken.html"), path.join(sandboxDir, "views", "index.html"));

      const drifted = await runComparison({
        source: { kind: "project", projectId: project.id, routeId: scenario.routeId },
        mode: "baseline",
        viewportId: viewport.id,
        origin: "http://127.0.0.1",
        projects: [project],
      });
      if (drifted.status !== "regression") {
        throw new Error(`${scenario.id}: the drifted page did not read as a regression (${drifted.status})`);
      }
      target = { reportId: drifted.id };
    }

    // Free the port: the repair starts its own server, and refuses to run when it cannot
    // prove the process answering at that URL is its own.
    await stopServers();

    const reference = await referencePatch(scenario, sourceDir);
    if (!live) {
      stub = await startStubModel(({ user }) => {
        const key = offeredIssueKeys(user).find((entry) => entry.startsWith(scenario.issuePrefix));
        if (!key) throw new Error(`no ${scenario.issuePrefix} issue was offered`);
        return proposalJson({ issueKey: key, patch: reference });
      });
    }

    const outcome = await runRepair({
      ...target,
      maxAttempts: 2,
      lookupProject: () => ({ project, sourceDir, from: "benchmark manifest" }),
      ...(stub ? { env: { UIPROOF_AI_API_KEY: "stub-key", UIPROOF_AI_BASE_URL: stub.baseUrl, UIPROOF_AI_MODEL: "stub-model" } } : {}),
    });
    repair = outcome.repair;
    // The original application must be exactly as it was: a benchmark cannot be paid for
    // out of the tree under test.
    if (!repair.originalUnchanged) throw new Error(`${scenario.id}: the source tree changed during the run`);
  } catch (cause) {
    failure = (cause as Error).message;
  } finally {
    await stopServers();
    await stub?.stop().catch(() => undefined);
    await executor?.cleanup().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const promptChars = repair?.attempts.reduce((total, attempt) => total + (attempt.model?.promptChars ?? 0), 0) ?? 0;
  const responseChars = repair?.attempts.reduce((total, attempt) => total + (attempt.model?.responseChars ?? 0), 0) ?? 0;

  return {
    id: scenario.id,
    fixture: scenario.fixture,
    category: scenario.category,
    issue: repair?.attempts.find((attempt) => attempt.proposal)?.proposal?.issueKey ?? null,
    verdict: repair?.status ?? "unverified",
    executionMode: repair?.execution.mode ?? null,
    execution: repair?.execution.summary ?? null,
    attempts: repair?.attempts.length ?? 0,
    verifiedAtAttempt: repair?.verifiedAttempt ?? null,
    verdicts: (repair?.attempts ?? [])
      .filter((attempt) => attempt.verification !== null)
      .map((attempt) => ({
        attempt: attempt.attempt,
        verdict: attempt.verdict,
        reasons: attempt.verification?.reasons ?? [],
        targets: (attempt.verification?.targets ?? []).map((target) => ({
          issueKey: target.issueKey,
          status: target.status,
          before: target.before,
          after: target.after,
        })),
        regressions: (attempt.verification?.regressions ?? [])
          .filter((check) => check.status !== "clear")
          .map((check) => ({ kind: check.kind, id: check.id, status: check.status, detail: check.detail })),
      })),
    rejections: (repair?.attempts ?? []).flatMap((attempt) => (attempt.rejection ? [attempt.rejection] : [])),
    durationMs: Date.now() - started,
    promptChars,
    responseChars,
    // A rough, stated estimate: four characters per token, which is the usual rule of thumb
    // for English prose and JSON. It is not a tokeniser and the report says so.
    estimatedPromptTokens: Math.ceil(promptChars / 4),
    estimatedResponseTokens: Math.ceil(responseChars / 4),
    error: failure,
    warnings: repair?.warnings ?? [],
  };
}

describe("repair benchmark", () => {
  afterAll(async () => {
    await stopServers();
    if (previousDataDir === undefined) delete process.env.UIPROOF_DATA_DIR;
    else process.env.UIPROOF_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("runs every scenario in the manifest and writes the report", async () => {
    if (!dockerAvailable) {
      console.warn(`benchmark skipped: ${skipReason}`);
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }

    previousDataDir = process.env.UIPROOF_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-bench-store-"));
    process.env.UIPROOF_DATA_DIR = dataDir;

    for (const [index, scenario] of scenarios.entries()) {
      const result = await runScenario(scenario, index);
      results.push(result);
      console.warn(
        `benchmark ${result.id}: ${result.verdict}${result.error ? ` (${result.error})` : ""} in ${Math.round(result.durationMs / 1000)}s`,
      );
    }

    const verified = results.filter((entry) => entry.verdict === "verified");
    const drifted = results.filter((entry) => entry.error !== null);
    const promptTokens = results.reduce((total, entry) => total + entry.estimatedPromptTokens, 0);
    const responseTokens = results.reduce((total, entry) => total + entry.estimatedResponseTokens, 0);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const report = {
      name: "uiproof-repair-benchmark",
      runAt: new Date().toISOString(),
      mode: live ? "live-model" : "deterministic-stub",
      requested: requestedIds.length > 0 ? requestedIds : ["all"],
      model: reportedModel,
      endpoint: live ? (configured.config?.endpointHost ?? null) : null,
      runtime: `${probe?.runtime?.runtime ?? "unknown"} ${probe?.runtime?.serverVersion ?? ""}`.trim(),
      totals: {
        scenarios: results.length,
        verified: verified.length,
        verifiedAtFirstAttempt: verified.filter((entry) => entry.verifiedAtAttempt === 1).length,
        failed: drifted.length,
        medianDurationMs: median(results.map((entry) => entry.durationMs)),
        promptChars: results.reduce((total, entry) => total + entry.promptChars, 0),
        responseChars: results.reduce((total, entry) => total + entry.responseChars, 0),
        estimatedPromptTokens: promptTokens,
        estimatedResponseTokens: responseTokens,
        estimatedCostUsd: priceKnown ? ((promptTokens + responseTokens) / 1_000_000) * pricePerMillionTokens : null,
      },
      caveats: [
        live
          ? "Every patch in this run was written by the configured model."
          : "These patches came from the deterministic stub in e2e/support/stub-model.ts, which answers with the reference fix from benchmark/defects.json. The harness and the pipeline are measured here; a model's ability to fix these defects is not.",
        "Token counts are estimated at four characters per token, not counted by a tokeniser.",
        priceKnown
          ? "Cost is the estimate x the price the operator supplied in UIPROOF_BENCHMARK_PRICE_PER_MTOK; no provider invoice was consulted."
          : "No price was supplied (UIPROOF_BENCHMARK_PRICE_PER_MTOK), so no cost is reported — an invented one would be worse than none.",
        "Each scenario runs in container execution: no network, read-only root, dropped capabilities.",
      ],
      scenarios: scenarios.map((scenario) => ({ ...scenario, result: results.find((entry) => entry.id === scenario.id) ?? null })),
    };

    const outDir = path.join(process.cwd(), "docs", "benchmark");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "latest.md"), markdownReport(report), "utf8");

    console.warn(markdownReport(report));
    // The benchmark's own contract: every scenario ran and produced a verdict. Whether a
    // model fixed the defect is a measurement, not a test failure.
    expect(results).toHaveLength(scenarios.length);
    expect(drifted.map((entry) => `${entry.id}: ${entry.error}`).join("\n")).toBe("");
  }, 3_600_000);
});

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function markdownReport(report: {
  readonly runAt: string;
  readonly mode: string;
  readonly requested: readonly string[];
  readonly model: string | null;
  readonly runtime: string;
  readonly totals: Record<string, number | null>;
  readonly caveats: readonly string[];
  readonly scenarios: readonly { id: string; category: string; fixture: string; note: string; result: { verdict: string; executionMode: string | null; attempts: number; verifiedAtAttempt: number | null; durationMs: number; estimatedPromptTokens: number; estimatedResponseTokens: number; issue: string | null } | null }[];
}): string {
  const rows = report.scenarios.map((scenario) => {
      const result = scenario.result;
      if (!result) return `| ${scenario.id} | ${scenario.category} | not run | – | – | – | – | – |`;
      return `| ${scenario.id} | ${scenario.category} | ${result.verdict} | ${result.executionMode ?? "–"} | ${result.attempts} | ${result.verifiedAtAttempt ?? "–"} | ${Math.round(result.durationMs / 1000)}s | ${result.estimatedPromptTokens + result.estimatedResponseTokens} |`;
    })
    .join("\n");

  return `# Repair benchmark — ${report.runAt}

- **Mode:** ${report.mode}${report.model ? ` (${report.model})` : ""}
- **Requested:** ${report.requested.join(", ")}${report.requested.includes("all") ? "" : " — a subset, not the full manifest"}
- **Runtime:** ${report.runtime}
- **Scenarios:** ${report.totals.scenarios} · verified ${report.totals.verified} · verified on the first attempt ${report.totals.verifiedAtFirstAttempt} · failed to run ${report.totals.failed}
- **Median duration:** ${report.totals.medianDurationMs} ms
- **Estimated tokens:** ${report.totals.estimatedPromptTokens} prompt + ${report.totals.estimatedResponseTokens} response
- **Estimated cost:** ${report.totals.estimatedCostUsd === null ? "not reported (no price supplied)" : `$${report.totals.estimatedCostUsd.toFixed(4)}`}

| Scenario | Category | Verdict | Isolation | Attempts | Verified at | Duration | Est. tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Caveats, as recorded by the run

${report.caveats.map((caveat) => `- ${caveat}`).join("\n")}

## What each scenario is

${report.scenarios.map((scenario) => `- **${scenario.id}** (${scenario.fixture}): ${scenario.note}`).join("\n")}
`;
}
