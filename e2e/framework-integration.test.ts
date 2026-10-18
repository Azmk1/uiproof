import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisteredProject } from "@/lib/compare/types";
import { runQualityAudit } from "@/lib/quality/audit";
import {
  createRepairExecutor,
  executionConfig,
  probeContainerRuntime,
  type RepairExecutor,
} from "@/lib/repair/container";
import { runRepair } from "@/lib/repair/engine";
import { issuesFromQualityReport } from "@/lib/diagnosis/context";
import { offeredIssueKeys, proposalJson, replaceLinePatch, startStubModel } from "./support/stub-model";

/**
 * Phase 9: UIProof installed into applications it did not write.
 *
 * `examples/vite-app` and `examples/next-app` are ordinary applications with their own
 * manifests, their own lockfiles, their own build, their own test command and a real defect
 * apiece. Nothing here is UIProof-aware: the fixtures do not import UIProof, and the only
 * cooperation they offer is configuration a container needs anyway (a port from the
 * environment, caches inside the project).
 *
 * The container runtime is the sandbox: no network interface, a read-only root filesystem,
 * a read-only dependency volume, no capabilities. Inside it the application's own
 * `npm ci`, `npm run build`, `npm test` and preview server run, and UIProof measures the
 * result over the relay. This is the "does it work on somebody else's application"
 * question the phase asks, answered with the application's own toolchain.
 *
 * Docker is required. When no runtime answers the suite says so and skips; the report
 * records that as a skipped check, never as a pass.
 */

const IMAGE = process.env.UIPROOF_E2E_IMAGE ?? "node:24-bookworm-slim";

interface Framework {
  readonly id: string;
  readonly directory: string;
  readonly routePath: string;
  /** The line the stub patch replaces, and what it replaces it with. */
  readonly patch: {
    readonly file: string;
    readonly oldLine: string;
    readonly newLines: readonly string[];
  };
  readonly expectedIssuePrefix: string;
}

const FRAMEWORKS: readonly Framework[] = [
  {
    id: "vite-app",
    directory: path.join("examples", "vite-app"),
    routePath: "/",
    expectedIssuePrefix: "a11y:label@",
    patch: {
      file: "src/pages/Home.jsx",
      oldLine: '        <input id="support-email" name="email" type="email" />',
      newLines: [
        '        <label htmlFor="support-email">Email</label>',
        '        <input id="support-email" name="email" type="email" />',
      ],
    },
  },
  {
    id: "next-app",
    directory: path.join("examples", "next-app"),
    routePath: "/",
    expectedIssuePrefix: "a11y:label@",
    patch: {
      file: "app/page.jsx",
      oldLine: '        <input id="contact-email" name="email" type="email" />',
      newLines: [
        '        <label htmlFor="contact-email">Email</label>',
        '        <input id="contact-email" name="email" type="email" />',
      ],
    },
  },
];

const probe = await probeContainerRuntime({ refresh: true }).catch(() => null);
const dockerAvailable = probe?.available === true;
const skipReason = dockerAvailable ? "" : (probe?.reason ?? "the container runtime could not be probed");

describe("framework integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let dataDir = "";
  let previousDataDir: string | undefined;
  let stub: Awaited<ReturnType<typeof startStubModel>> | null = null;

  beforeAll(async () => {
    if (!dockerAvailable) return;
    previousDataDir = process.env.UIPROOF_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-frameworks-"));
    process.env.UIPROOF_DATA_DIR = dataDir;
    // One deterministic answer for every fixture: the patch the test just computed from
    // that fixture's own source. A real model would write its own; the pipeline under test
    // is UIProof's, not a model's.
    stub = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.includes("label@"));
      if (!key) throw new Error(`No label issue was offered: ${offeredIssueKeys(user).join(", ")}`);
      return proposalJson({ issueKey: key, patch: pendingPatch });
    });
  }, 300_000);

  afterAll(async () => {
    await stub?.stop().catch(() => undefined);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.UIPROOF_DATA_DIR;
    else process.env.UIPROOF_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  let pendingPatch = "";

  for (const framework of FRAMEWORKS) {
    describe(framework.id, () => {
      let workDir = "";
      let sourceDir = "";
      let sandboxDir = "";
      let helperDir = "";
      let executor: RepairExecutor | null = null;
      let server: Awaited<ReturnType<RepairExecutor["startServer"]>> | null = null;
      let project: RegisteredProject | null = null;
      let originUrl = "";
      const volume = `uiproof-e2e-${framework.id}-deps`;
      const sandboxPort = framework.id === "vite-app" ? 4199 : 4200;

      beforeAll(async () => {
        if (!dockerAvailable) return;
        workDir = await mkdtemp(path.join(os.tmpdir(), `uiproof-${framework.id}-`));
        sourceDir = path.join(workDir, "source");
        sandboxDir = path.join(workDir, "sandbox");
        helperDir = path.join(workDir, "relay");
        // A copy of the fixture, so the repository is never the tree under repair.
        await cp(path.join(process.cwd(), framework.directory), sourceDir, { recursive: true });
        await cp(sourceDir, sandboxDir, { recursive: true });

        executor = await createRepairExecutor({
          config: executionConfig({
            image: IMAGE,
            network: "none",
            memoryMb: 2048,
            cpus: 2,
            dependenciesVolume: volume,
            install: ["npm", "ci", "--no-audit", "--no-fund"],
          }),
          sandboxDir,
          helperDir,
          runId: framework.id.slice(0, 8),
        });
        cleanups.push(async () => {
          await server?.stop().catch(() => undefined);
          await executor?.cleanup().catch(() => undefined);
          await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        });

        // The application's own build, inside the container, before anything is measured.
        const build = await executor.runCommand({
          name: "build",
          command: ["npm", "run", "build"],
          timeoutMs: 15 * 60_000,
        });
        if (build.status !== "passed") {
          throw new Error(`${framework.id}: npm run build failed in the container\n${build.outputTail}`);
        }

        const test = await executor.runCommand({
          name: "test",
          command: ["npm", "test"],
          timeoutMs: 5 * 60_000,
        });
        if (test.status !== "passed") {
          throw new Error(`${framework.id}: npm test failed in the container\n${test.outputTail}`);
        }

        // The application's own preview server, relayed to loopback on this machine.
        originUrl = `http://127.0.0.1:${sandboxPort}`;
        server = await executor.startServer({
          command: ["npm", "run", "start"],
          url: originUrl,
          readyPath: framework.routePath,
          env: { PORT: String(sandboxPort), HOST: "127.0.0.1" },
        });

        project = {
          id: framework.id,
          name: framework.id,
          origin: originUrl,
          routes: [
            { id: "home", name: "Home", path: framework.routePath, url: `${originUrl}${framework.routePath}` },
            { id: "settings", name: "Settings", path: "/settings", url: `${originUrl}/settings` },
          ],
          modes: ["capture", "baseline"],
          defaultMode: "capture",
          allowedOrigins: [],
          sourceDir,
          repair: {
            sandbox: {
              command: ["npm", "run", "start"],
              url: originUrl,
              readyPath: framework.routePath,
              env: { PORT: String(sandboxPort), HOST: "127.0.0.1" },
            },
            build: ["npm", "run", "build"],
            test: ["npm", "test"],
            allow: ["src/**", "app/**", "styles/**"],
            guardRoutes: ["settings"],
            entryFiles: [framework.patch.file],
            execution: executionConfig({
              image: IMAGE,
              network: "none",
              dependenciesVolume: volume,
              install: ["npm", "ci", "--no-audit", "--no-fund"],
            }),
          },
        };
      }, 1_800_000);

      it("serves the application through the relay from a container with no network", async () => {
        if (!dockerAvailable) {
          console.warn(`framework integration e2e skipped: ${skipReason}`);
          expect(skipReason.length).toBeGreaterThan(0);
          return;
        }
        const response = await fetch(`${originUrl}${framework.routePath}`, { redirect: "manual" });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toMatch(/<!doctype html/i);
        // Framework output, not a static fixture: the preview server logged its own start.
        expect(server!.log().length).toBeGreaterThan(0);

        const settings = await fetch(`${originUrl}/settings`, { redirect: "manual" });
        expect(settings.status).toBe(200);
      }, 120_000);

      it("audits both routes at two viewports and repairs the defect in the container", async () => {
        if (!dockerAvailable) return;
        const { report } = await runQualityAudit({
          source: { kind: "project", projectId: framework.id, routeId: "home" },
          viewports: ["desktop", "mobile"],
          origin: "http://127.0.0.1",
          projects: [project!],
          persist: true,
        });
        const { issues } = issuesFromQualityReport(report);
        const issue = issues.find((entry) => entry.key.startsWith(framework.expectedIssuePrefix));
        expect(issue, `issues: ${issues.map((entry) => entry.key).join(", ")}`).toBeDefined();

        // The audit above measured the containerized application through the relay. Release
        // the port for the repair, which starts its own server on the sandbox URL — and
        // refuses to run when it cannot prove that the process answering is its own.
        await server!.stop();
        server = null;

        const original = await readFile(path.join(sourceDir, framework.patch.file), "utf8");
        pendingPatch = replaceLinePatch(
          framework.patch.file,
          original,
          framework.patch.oldLine,
          framework.patch.newLines,
        );

        const { repair } = await runRepair({
          auditId: report.id,
          maxAttempts: 1,
          lookupProject: () => ({ project: project!, sourceDir, from: "framework e2e registration" }),
          env: {
            UIPROOF_AI_API_KEY: "stub-key",
            UIPROOF_AI_BASE_URL: stub!.baseUrl,
            UIPROOF_AI_MODEL: "stub-model",
          },
        });

        expect(repair.execution.mode).toBe("container");
        expect(repair.execution.network).toBe("none");
        expect(repair.execution.dependenciesVolume).toBe(volume);
        expect(repair.status).toBe("verified");
        expect(repair.attempts[0].verification?.build.map((command) => `${command.name}:${command.status}`)).toEqual([
          "build:passed",
          "test:passed",
        ]);
        // The real toolchain ran: the build output names the framework's own build.
        expect(repair.baselineCommands.map((command) => command.status)).toEqual(["passed", "passed"]);

        // Both registered routes were measured before and after, at the report's viewport.
        const before = repair.before.pages.map((page) => `${page.routeId}@${page.viewportId}`).sort();
        const after = repair.attempts[0].verification!.after!.pages.map((page) => `${page.routeId}@${page.viewportId}`).sort();
        expect(before).toContain(`home@${report.viewports[0].viewport.id}`);
        expect(after).toEqual(before);
        expect(repair.attempts[0].verification!.regressions.filter((check) => check.status !== "clear")).toEqual([]);

        // The application's own tree was never written to; the patch exists only in the record.
        expect(repair.originalUnchanged).toBe(true);
        expect(await readFile(path.join(sourceDir, framework.patch.file), "utf8")).toBe(original);
      }, 1_800_000);

      it("leaves no container and no dependency volume behind in the wrong place", async () => {
        if (!dockerAvailable) return;
        await executor!.cleanup();
        const listed = await new Promise<string>((resolve) => {
          execFile(
            "docker",
            ["ps", "--all", "--filter", `label=uiproof.repair=${framework.id.slice(0, 8)}`, "--format", "{{.Names}}"],
            { timeout: 30_000 },
            (error, stdout) => resolve(error ? "" : String(stdout)),
          );
        });
        expect(listed.trim()).toBe("");
        const volumeCheck = await new Promise<string>((resolve) => {
          execFile("docker", ["volume", "inspect", volume, "--format", "{{.Name}}"], { timeout: 30_000 }, (error, stdout) =>
            resolve(error ? "" : String(stdout).trim()),
          );
        });
        // The dependency volume is the only thing a run is allowed to keep: re-installing it
        // per attempt would be the expensive half of every repair.
        expect(volumeCheck).toBe(volume);
      }, 120_000);
    });
  }

  it("reports which runtime the container execution actually used", () => {
    if (!dockerAvailable) {
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }
    expect(probe?.runtime?.runtime).toBe("docker");
    expect(probe?.runtime?.serverVersion?.length ?? 0).toBeGreaterThan(0);
  });
});
