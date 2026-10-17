import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./support/cli";
import {
  pickFreePort,
  startExampleApp,
  writeProjectConfig,
  type ExampleApp,
} from "./support/example-app";

/**
 * Phase 4, end to end: the CLI as a developer and a CI job actually run it.
 *
 * Every assertion here goes through the real process — `node scripts/uiproof.mjs …` bundles
 * the TypeScript CLI and runs it, Chromium captures the example application over HTTP, and
 * the exit codes are read from the process, not from a function call. Nothing is stubbed:
 * the store is a temporary directory, the registration file is a hand-written JSON file,
 * and the "UI change" is a real edit to the application's own view.
 *
 * The contract the suite pins down:
 *   · 0 pass / capture, 1 regression, 2 everything that stopped the tool answering;
 *   · `--json` prints one JSON document whose report equals the one persisted on disk;
 *   · a portable bundle survives a fresh working directory with no prior state;
 *   · a clean CI-style run detects a real regression.
 */

const PROJECT_ID = "example-app";
const VIEWPORT = "desktop";

describe("uiproof CLI", () => {
  let app: ExampleApp;
  let scratch = "";
  let configPath = "";
  let offlineConfigPath = "";
  let storeDir = "";
  let bundleDir = "";
  let freshCwd = "";
  let approvalStoreDir = "";
  let approvedVersionId = "";
  let approvedRunId = "";

  const cliEnv = (): Record<string, string> => ({
    UIPROOF_PROJECTS_FILE: configPath,
    UIPROOF_DATA_DIR: storeDir,
  });

  const target = (extra: readonly string[] = []): string[] => [
    "--project",
    PROJECT_ID,
    "--route",
    "home",
    "--config",
    configPath,
    ...extra,
  ];

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [5301, 5302, 5303, 5304] });
    scratch = path.join(os.tmpdir(), `uiproof-cli-${randomUUID()}`);
    storeDir = path.join(scratch, "data");
    bundleDir = path.join(scratch, "uiproof-baselines");
    approvalStoreDir = path.join(scratch, "store-without-activation", "data");
    freshCwd = path.join(scratch, "clean-runner");
    await mkdir(freshCwd, { recursive: true });

    configPath = path.join(scratch, "uiproof.config.json");
    await writeProjectConfig(configPath, [
      {
        id: PROJECT_ID,
        name: "Example app",
        origin: app.url,
        routes: [
          { id: "home", name: "Overview", path: "/" },
          { id: "settings", name: "Settings", path: "/settings" },
          { id: "moved", name: "Redirects away", path: "/moved" },
        ],
      },
    ]);

    // A second registration pointing at a port nothing is listening on.
    offlineConfigPath = path.join(scratch, "offline.config.json");
    const deadPort = await pickFreePort([5391, 5392, 5393]);
    await writeProjectConfig(offlineConfigPath, [
      { id: "offline-app", name: "Offline app", origin: `http://127.0.0.1:${deadPort}`, routes: [{ id: "home", name: "Home", path: "/" }] },
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("documents its exit codes in --help and reports its version", async () => {
    const version = await runCli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Exit codes");
    expect(help.stdout).toMatch(/0\s+the comparison passed/);
    expect(help.stdout).toMatch(/1\s+a visual regression was detected/);
    expect(help.stdout).toMatch(/2\s+configuration, baseline, browser or infrastructure error/);
    expect(help.stdout).toContain("baselines export");
  });

  it("exits 2 for a usage error, without doing any work", async () => {
    const badTolerance = await runCli([...target(), "--tolerance", "500"]);
    expect(badTolerance.code).toBe(2);
    expect(badTolerance.stderr).toMatch(/--tolerance must be a number between 0 and 100/);

    const unknownCommand = await runCli(["nonsense"]);
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toMatch(/Unknown command/);
  });

  it("lists the registered project and its routes", async () => {
    const run = await runCli(["projects", "--config", configPath, "--json"], { env: cliEnv() });
    expect(run.code).toBe(0);
    const projects = run.json?.projects as Array<{ id: string; origin: string; routes: Array<{ id: string }> }>;
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(PROJECT_ID);
    expect(projects[0].origin).toBe(app.url);
    expect(projects[0].routes.map((route) => route.id)).toContain("home");
    // Machine-readable output is machine-readable: the human trail went to stderr.
    expect(run.stderr).toMatch(/project\(s\) in/);
  });

  it("exits 2 when no baseline has been approved", async () => {
    const run = await runCli(["check", ...target(), "--json"], { env: cliEnv() });
    expect(run.code).toBe(2);
    expect((run.json?.error as { code: string }).code).toBe("baseline_not_found");
    // The audit trail is on stderr, and the JSON document is intact.
    expect(run.stderr).toMatch(/No approved baseline/);
    expect(run.stderr).toContain("uiproof capture --project");
  });

  it("captures with --approve: exit 0, status captured — never a pass", async () => {
    const run = await runCli(["capture", ...target(), "--approve", "--json"], { env: cliEnv() });
    expect(run.code).toBe(0);
    expect(run.json?.status).toBe("captured");
    expect(run.json?.exitCode).toBe(0);

    const approved = run.json?.approved as { id: string } | null;
    const report = run.json?.report as { id: string; status: string };
    approvedVersionId = approved!.id;
    approvedRunId = report.id;

    // The JSON the CLI printed is the report that is on disk, byte for byte.
    const persisted = JSON.parse(
      await readFile(path.join(storeDir, "reports", report.id, "report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(report);

    // A capture stores the screenshot; it does not claim a comparison happened.
    const png = await readFile(path.join(storeDir, "reports", report.id, "current.png"));
    expect(png.byteLength).toBeGreaterThan(1000);
    expect(report.status).toBe("captured");
  });

  it("passes on the unchanged page, and the JSON matches the persisted report", async () => {
    const run = await runCli(["check", ...target(), "--json"], { env: cliEnv() });
    expect(run.code).toBe(0);
    expect(run.json?.status).toBe("pass");

    const report = run.json?.report as {
      id: string;
      status: string;
      metrics: { changePercentage: number; changedPixels: number; maxDiffPercent: number };
      baseline: { versionId: string } | null;
    };
    expect(report.status).toBe("pass");
    expect(report.baseline?.versionId).toBe(approvedVersionId);
    expect(report.metrics.changePercentage).toBeLessThanOrEqual(report.metrics.maxDiffPercent);
    expect(run.json?.tolerance).toBe(report.metrics.maxDiffPercent);

    const persisted = JSON.parse(
      await readFile(path.join(storeDir, "reports", report.id, "report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(report);
    expect((persisted as { id: string }).id).toBe(report.id);

    // The run's artifacts are on disk next to the report.
    await expect(readFile(path.join(storeDir, "reports", report.id, "current.png"))).resolves.toBeTruthy();
    await expect(readFile(path.join(storeDir, "reports", report.id, "baseline.png"))).resolves.toBeTruthy();
  });

  it("exits 1 after a real UI change, and 0 again once the change is reverted", async () => {
    await app.applyUiChange();
    const regression = await runCli(["check", ...target(), "--json"], { env: cliEnv() });
    expect(regression.code).toBe(1);
    expect(regression.json?.status).toBe("regression");
    expect(regression.json?.exitCode).toBe(1);

    const report = regression.json?.report as {
      id: string;
      status: string;
      metrics: { changePercentage: number; maxDiffPercent: number; changedPixels: number };
    };
    expect(report.status).toBe("regression");
    expect(report.metrics.changePercentage).toBeGreaterThan(report.metrics.maxDiffPercent);
    expect(report.metrics.changedPixels).toBeGreaterThan(1000);
    expect(regression.stderr).toMatch(/REGRESSION/);

    const persisted = JSON.parse(
      await readFile(path.join(storeDir, "reports", report.id, "report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(report);

    // The failing run did not touch the approved baseline: same version, same revision.
    const status = await runCli(["baselines", "status", "--json"], { env: cliEnv() });
    const entry = (status.json?.baselines as Array<{ activeVersionId: string; versions: unknown[] }>)[0];
    expect(entry.activeVersionId).toBe(approvedVersionId);
    expect(entry.versions).toHaveLength(1);

    await app.restoreUi();
    const recovered = await runCli(["check", ...target()], { env: cliEnv() });
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toMatch(/PASS/);
  });

  it("exits 2 for an unknown project, an unknown route, a redirecting route and an unreachable app", async () => {
    const unknownProject = await runCli(["check", "--project", "nope", "--route", "home", "--config", configPath], {
      env: cliEnv(),
    });
    expect(unknownProject.code).toBe(2);
    expect(unknownProject.stderr).toMatch(/is not registered/);

    const unknownRoute = await runCli(["check", "--project", PROJECT_ID, "--route", "nope", "--config", configPath], {
      env: cliEnv(),
    });
    expect(unknownRoute.code).toBe(2);
    expect(unknownRoute.stderr).toMatch(/is not registered/);

    const unknownViewport = await runCli(["check", ...target(), "--viewport", "watch"], { env: cliEnv() });
    expect(unknownViewport.code).toBe(2);
    expect(unknownViewport.stderr).toMatch(/Unknown viewport/);

    const redirects = await runCli(
      ["capture", "--project", PROJECT_ID, "--route", "moved", "--config", configPath],
      { env: cliEnv() },
    );
    expect(redirects.code).toBe(2);
    expect(redirects.stderr).toMatch(/redirected to/);

    // A registered project whose development server is not running. A capture probes the
    // origin first, so the failure names the application rather than the missing baseline.
    const unreachable = await runCli(
      ["capture", "--project", "offline-app", "--route", "home", "--config", offlineConfigPath, "--json"],
      { env: cliEnv() },
    );
    expect(unreachable.code).toBe(2);
    expect((unreachable.json?.error as { code: string }).code).toBe("project_unreachable");
    expect(unreachable.stderr).toMatch(/Nothing answered/);

    // `check` against the same project is still an error, never a silent pass.
    const unreachableCheck = await runCli(
      ["check", "--project", "offline-app", "--route", "home", "--config", offlineConfigPath],
      { env: cliEnv() },
    );
    expect(unreachableCheck.code).toBe(2);
  });

  it("exports a portable bundle containing the approved image", async () => {
    const run = await runCli(
      ["baselines", "export", "--project", PROJECT_ID, "--route", "home", "--out", bundleDir, "--json"],
      { env: cliEnv() },
    );
    expect(run.code).toBe(0);
    expect(run.json?.versions).toBe(1);
    expect(run.json?.scopes).toBe(1);

    const manifest = JSON.parse(await readFile(path.join(bundleDir, "uiproof-baselines.json"), "utf8")) as {
      format: string;
      scopes: Array<{ activeVersionId: string; viewportId: string; versions: Array<{ id: string; sha256: string; file: string }> }>;
    };
    expect(manifest.format).toBe("uiproof-baselines");
    expect(manifest.scopes[0].activeVersionId).toBe(approvedVersionId);
    expect(manifest.scopes[0].viewportId).toBe(VIEWPORT);
    const version = manifest.scopes[0].versions[0];
    expect(version.sha256).toHaveLength(64);
    const bundled = await readFile(path.join(bundleDir, version.file));
    expect(bundled.byteLength).toBeGreaterThan(1000);
  });

  it("loads that bundle in a fresh working directory and gates a real regression there", async () => {
    const imported = await runCli(["baselines", "import", "--from", bundleDir, "--activate", "--json"], {
      cwd: freshCwd,
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: path.join(freshCwd, "data") },
    });
    expect(imported.code).toBe(0);
    expect(imported.json?.added).toBe(1);
    expect(imported.json?.alreadyPresent).toBe(0);

    const freshEnv = { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: path.join(freshCwd, "data") };
    const pass = await runCli(
      ["check", "--project", PROJECT_ID, "--route", "home", "--config", configPath, "--json"],
      { cwd: freshCwd, env: freshEnv },
    );
    expect(pass.code).toBe(0);
    expect(pass.json?.status).toBe("pass");

    // A clean CI-style run: change the application, gate, then restore.
    await app.applyUiChange();
    const regression = await runCli(
      ["check", "--project", PROJECT_ID, "--route", "home", "--config", configPath, "--json"],
      { cwd: freshCwd, env: freshEnv },
    );
    expect(regression.code).toBe(1);
    expect(regression.json?.status).toBe("regression");

    await app.restoreUi();
    const recovered = await runCli(
      ["check", "--project", PROJECT_ID, "--route", "home", "--config", configPath],
      { cwd: freshCwd, env: freshEnv },
    );
    expect(recovered.code).toBe(0);
  });

  it("does not activate an imported baseline unless --activate was asked for", async () => {
    const imported = await runCli(["baselines", "import", "--from", bundleDir, "--json"], {
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: approvalStoreDir },
    });
    expect(imported.code).toBe(0);
    expect(imported.json?.added).toBe(1);
    expect(imported.json?.activated).toBe(false);
    expect(imported.stderr).toMatch(/stored but not active/);

    // A version that exists but was never activated cannot be compared against.
    const notApproved = await runCli(["check", ...target(), "--json"], {
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: approvalStoreDir },
    });
    expect(notApproved.code).toBe(2);
    expect((notApproved.json?.error as { code: string }).code).toBe("baseline_not_found");

    // Importing the same bundle again is a no-op, and this time it activates.
    const activated = await runCli(["baselines", "import", "--from", bundleDir, "--activate", "--json"], {
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: approvalStoreDir },
    });
    expect(activated.code).toBe(0);
    expect(activated.json?.added).toBe(0);
    expect(activated.json?.alreadyPresent).toBe(1);

    const approved = await runCli(["check", ...target()], {
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: approvalStoreDir },
    });
    expect(approved.code).toBe(0);
  });

  it("exits 2 for a bundle whose image was tampered with", async () => {
    const tampered = path.join(scratch, "tampered-bundle");
    await mkdir(tampered, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(bundleDir, "uiproof-baselines.json"), "utf8")) as {
      scopes: Array<{ versions: Array<{ file: string }> }>;
    };
    const relative = manifest.scopes[0].versions[0].file;
    const original = await readFile(path.join(bundleDir, relative));
    await mkdir(path.dirname(path.join(tampered, relative)), { recursive: true });
    await writeFile(path.join(tampered, "uiproof-baselines.json"), await readFile(path.join(bundleDir, "uiproof-baselines.json")));
    const damaged = Buffer.from(original);
    damaged[damaged.byteLength - 1] ^= 0xff;
    await writeFile(path.join(tampered, relative), damaged);

    const run = await runCli(["baselines", "import", "--from", tampered, "--json"], {
      env: { UIPROOF_PROJECTS_FILE: configPath, UIPROOF_DATA_DIR: path.join(scratch, "tampered-store") },
    });
    expect(run.code).toBe(2);
    expect((run.json?.error as { code: string }).code).toBe("baseline_integrity_failed");
    expect(run.stderr).toMatch(/SHA-256/);
  });

  it("remembers the run it approved, and reports it through baselines status", async () => {
    const status = await runCli(["baselines", "status", "--project", PROJECT_ID, "--route", "home", "--json"], {
      env: cliEnv(),
    });
    expect(status.code).toBe(0);
    const entry = (status.json?.baselines as Array<{
      scopeKey: string;
      viewportId: string;
      activeVersionId: string;
      versions: Array<{ id: string; sourceReportId: string; capturedRoute: string }>;
    }>)[0];
    expect(entry.scopeKey).toBe(`project:${PROJECT_ID}/home`);
    expect(entry.viewportId).toBe(VIEWPORT);
    expect(entry.activeVersionId).toBe(approvedVersionId);
    expect(entry.versions[0].sourceReportId).toBe(approvedRunId);
    expect(entry.versions[0].capturedRoute).toBe("/");
  });
});
