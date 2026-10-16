import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { startE2eServer, type StartedE2eServer } from "./support/e2e-server";
import {
  EXAMPLE_ROUTES,
  pickFreePort,
  startExampleApp,
  UNSAFE_REGISTRATION,
  writeProjectConfig,
  type ExampleApp,
  type ProjectRegistration,
} from "./support/example-app";
import {
  eventually,
  expectText,
  expectVisible,
  launchBrowser,
  readDisplayedRunId,
  readHistoryCount,
  readVerdict,
  runComparison,
} from "./support/helpers";

/**
 * Phase 3, end to end, against an application UIProof did not write.
 *
 * The whole point of the phase is that the tool stops being a demo about itself. So this
 * suite starts a second web application on its own port, registers it the way a developer
 * would, and then walks the exact workflow the brief asks for:
 *
 *   1. start the example application
 *   2. register it with UIProof
 *   3. capture one of its pages
 *   4. approve that screenshot as the baseline
 *   5. change the application's real UI (its own view file)
 *   6. detect a measurable regression
 *   7. restore the original UI
 *   8. verify it passes again
 *   9. restart UIProof and confirm the report and baseline are still there
 *
 * plus the refusals: an unregistered project, a route that redirects off the registered
 * origin, an unsafe path in the configuration file, an unreachable development server,
 * and a cross-site approval. Every number asserted here comes from a real Chromium
 * capture of the running application.
 */

const PROJECT_ID = "example-app";
const PROJECT_NAME = "Example app";
const VIEWPORT = "desktop";

const REGISTRATION: readonly ProjectRegistration[] = [
  { id: PROJECT_ID, name: PROJECT_NAME, origin: "", routes: EXAMPLE_ROUTES, allowedOrigins: [] },
];

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly text: string;
}

const PROJECT_SERVER_PORTS = [3310, 3311, 3312];

describe("registered local application", () => {
  let app: ExampleApp;
  let uiproof: StartedE2eServer;
  let browser: Browser;
  let page: Page;
  let base = "";
  let dataDir = "";
  let configPath = "";
  const scratchDirs: string[] = [];

  let approvedVersionId = "";
  let captureRunId = "";
  let regressionRunId = "";
  let regressionPercent = 0;

  async function api(pathname: string, init?: RequestInit): Promise<ApiResult> {
    const response = await fetch(`${base}${pathname}`, { cache: "no-store", ...init });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  }

  /** Fetches a binary artifact (a PNG) without going through a text decode. */
  async function apiBytes(pathname: string): Promise<{ readonly status: number; readonly bytes: Buffer; readonly contentType: string }> {
    const response = await fetch(`${base}${pathname}`, { cache: "no-store" });
    return {
      status: response.status,
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  /** A same-origin, same-site request — what the console itself sends. */
  function localInit(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    };
  }

  async function compare(body: unknown): Promise<ApiResult> {
    return api("/api/compare", localInit(body));
  }

  async function fetchRun(id: string) {
    const response = await api(`/api/reports/${id}`);
    if (response.status !== 200) throw new Error(`GET /api/reports/${id} → ${response.status}`);
    return (response.body as { report: Record<string, unknown> }).report as {
      id: string;
      status: string;
      mode: string;
      source: {
        kind: string;
        scopeKey: string;
        projectId: string;
        routeId: string;
        origin: string;
        path: string;
        blockedRequests: number;
      };
      target: { id: string; currentPath: string };
      viewport: { id: string };
      metrics: { changedPixels: number; comparedPixels: number; changePercentage: number };
      artifacts: Record<string, { url: string; bytes: number } | undefined>;
      baseline: { versionId: string } | null;
    };
  }

  async function fetchProjectBaseline() {
    const response = await api(`/api/baselines/projects/${PROJECT_ID}/overview/${VIEWPORT}`);
    if (response.status !== 200) throw new Error(`GET project baseline → ${response.status}`);
    return (response.body as { baseline: { activeVersionId: string | null; versions: Array<{ id: string; sourceReportId: string; capturedRoute: string; width: number; height: number }> } | null })
      .baseline;
  }

  async function startUiProof(options: {
    readonly registrations: readonly ProjectRegistration[];
    readonly dirs: string[];
    readonly ports: readonly number[];
    readonly label: string;
    /** Reuse an existing data directory — the restart case — instead of a fresh one. */
    readonly dir?: string;
  }): Promise<StartedE2eServer> {
    const dir = options.dir ?? path.join(os.tmpdir(), `uiproof-phase3-${randomUUID()}`);
    if (!options.dir) options.dirs.push(dir);
    const file = path.join(dir, "uiproof.config.json");
    // On a restart the file is already there and still correct; rewriting it would hide a
    // registration that a fresh process failed to read.
    if (!options.dir) await writeProjectConfig(file, options.registrations);
    return startE2eServer({
      label: options.label,
      dataDir: dir,
      portCandidates: options.ports,
      env: { UIPROOF_PROJECTS_FILE: file },
    });
  }

  /** Selects a source by the label a developer sees in the picker. */
  async function selectSource(label: RegExp) {
    await page.getByRole("group", { name: "Source" }).getByRole("radio", { name: label }).check();
  }

  /** Runs a capture-only pass and waits for the run to reach the history. */
  async function capture(page: Page): Promise<void> {
    await selectMode(page, /Capture only/i);
    await expectEnabledRun(page);
    const before = await readHistoryCount(page);
    await page.getByRole("button", { name: /Run comparison/i }).click();
    await eventually(async () => (await readHistoryCount(page)) > before, {
      timeoutMs: 60_000,
      message: "The capture never appeared in the run history",
    });
  }

  async function expectEnabledRun(target: Page) {
    await eventually(async () => await target.getByRole("button", { name: /Run comparison/i }).isEnabled(), {
      message: "The run button stayed disabled",
    });
  }

  function selectMode(target: Page, label: RegExp) {
    return target.getByRole("radio", { name: label }).check();
  }

  async function openConsole(): Promise<void> {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /catch every drift/i }).waitFor({ timeout: 20_000 });
  }

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [4273, 4274, 4275, 4276] });
    uiproof = await startUiProof({
      registrations: [{ ...REGISTRATION[0], origin: app.url }],
      dirs: scratchDirs,
      ports: PROJECT_SERVER_PORTS,
      label: "UIProof (registered project)",
    });
    base = uiproof.runtime.url;
    dataDir = uiproof.runtime.dataDir;
    configPath = path.join(dataDir, "uiproof.config.json");

    browser = await launchBrowser();
    page = await browser.newPage();
    await openConsole();
  }, 240_000);

  afterAll(async () => {
    await page?.context().close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await uiproof?.stop().catch(() => undefined);
    await app?.stop().catch(() => undefined);
    for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("1. serves the example application on its own origin", async () => {
    const health = await fetch(`${app.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const home = await fetch(`${app.url}/`);
    const html = await home.text();
    expect(home.status).toBe(200);
    // The shipped screen, before anybody touches it.
    expect(html).toContain("$48,200");
    expect(html).toContain("Monthly recurring revenue");
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("2. registers the application and offers its routes in the console", async () => {
    const catalog = await api("/api/catalog");
    expect(catalog.status).toBe(200);
    const body = catalog.body as {
      projects: Array<{ id: string; name: string; origin: string; routes: Array<{ id: string; path: string }> }>;
      projectConfigPath: string | null;
      projectConfigError: string | null;
    };
    expect(body.projectConfigError).toBeNull();
    expect(body.projectConfigPath).toBe(configPath);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].id).toBe(PROJECT_ID);
    expect(body.projects[0].name).toBe(PROJECT_NAME);
    expect(body.projects[0].origin).toBe(app.url);
    expect(body.projects[0].routes.map((route) => route.path)).toEqual(["/", "/settings", "/embedded", "/moved"]);

    // And the same thing in the UI: the project is named, with its origin, next to the
    // demo fixtures — one picker, no invented targets.
    const source = page.getByRole("group", { name: "Source" });
    await expectText(source, new RegExp(`${PROJECT_NAME}`));
    await expectText(source, new RegExp(`127\\.0\\.0\\.1:${app.port}`));
    for (const route of EXAMPLE_ROUTES) {
      await expectVisible(source.getByRole("radio", { name: new RegExp(`^${route.name}`) }));
    }
    await expectText(source, /Demo fixtures/);
  });

  it("3. refuses baseline mode while nothing is approved for the route", async () => {
    await selectSource(/^Overview/);
    expect(await fetchProjectBaseline()).toBeNull();

    await selectMode(page, /Approved baseline/i);
    await expectText(page.getByRole("group", { name: "Comparison mode" }), /No approved baseline/i);
    await eventually(async () => await page.getByRole("button", { name: /Run comparison/i }).isDisabled(), {
      message: "the run button was enabled without an approved baseline",
    });
  });

  it("4. captures the registered route and reports it as a capture, not a pass", async () => {
    await selectSource(/^Overview/);
    await capture(page);

    // A capture has no number to show, so it must not claim one.
    await expectText(page.locator('[aria-label="Comparison verdict"]'), /captured/i);
    const verdict = await readVerdict(page);
    expect(verdict.percent).toBeNull();
    expect(verdict.status).toBe("unknown");

    const runId = await readDisplayedRunId(page);
    expect(runId).toMatch(/^run-[0-9a-f-]{36}$/);
    const report = await fetchRun(runId!);
    expect(report.status).toBe("captured");
    expect(report.mode).toBe("capture");
    expect(report.source.kind).toBe("project");
    expect(report.source.projectId).toBe(PROJECT_ID);
    expect(report.source.routeId).toBe("overview");
    expect(report.source.scopeKey).toBe(`project:${PROJECT_ID}/overview`);
    expect(report.source.origin).toBe(app.url);
    expect(report.source.path).toBe("/");
    expect(report.metrics.comparedPixels).toBe(0);
    expect(report.artifacts.current).toBeDefined();
    expect(report.artifacts.baseline).toBeUndefined();
    expect(report.artifacts.diff).toBeUndefined();

    // The screenshot is a real, decodable PNG at the pinned viewport.
    const image = await apiBytes(`/api/artifacts/${report.id}/current.png`);
    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    const png = PNG.sync.read(image.bytes);
    expect([png.width, png.height]).toEqual([1280, 800]);

    // A capture fabricates no difference image.
    expect((await api(`/api/artifacts/${report.id}/diff.png`)).status).toBe(404);

    captureRunId = report.id;
  });

  it("5. approves the capture as the baseline through the console", async () => {
    const runId = await readDisplayedRunId(page);
    expect(runId).toBe(captureRunId);

    await page.getByRole("button", { name: /Approve this run as the baseline/i }).click();
    await expectVisible(page.getByText(new RegExp(`Approve run ${captureRunId}`)));
    await page.getByRole("button", { name: /Yes, approve it/i }).click();

    const baseline = await eventually(() => fetchProjectBaseline(), {
      message: "the project baseline was never stored",
    });
    expect(baseline?.versions).toHaveLength(1);
    expect(baseline?.versions[0].sourceReportId).toBe(captureRunId);
    expect(baseline?.versions[0].capturedRoute).toBe("/");
    expect([baseline?.versions[0].width, baseline?.versions[0].height]).toEqual([1280, 800]);
    expect(baseline?.activeVersionId).toBe(baseline?.versions[0].id);
    approvedVersionId = baseline!.activeVersionId!;

    // It is served as a real PNG, exactly like a demo baseline.
    const image = await apiBytes(`/api/baselines/projects/${PROJECT_ID}/overview/${VIEWPORT}/${approvedVersionId}.png`);
    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    expect(image.bytes.byteLength).toBeGreaterThan(1000);

    await expectText(page.locator('[aria-label="Approved baseline"]'), /active/i);
  });

  it("6. passes against the approved baseline while the application is unchanged", async () => {
    await selectSource(/^Overview/);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);

    const report = await fetchRun((await readDisplayedRunId(page))!);
    expect(report.mode).toBe("baseline");
    expect(report.metrics.changedPixels).toBe(0);
    expect(report.metrics.comparedPixels).toBe(1280 * 800);
    expect(report.baseline?.versionId).toBe(approvedVersionId);
  });

  it("7. restricts the capture's network to the registered origin", async () => {
    // `/embedded` pulls an image from another origin. It must be refused, and the capture
    // must still succeed — the request is blocked, not the page.
    await selectSource(/^Partners/);
    await capture(page);

    const report = await fetchRun((await readDisplayedRunId(page))!);
    expect(report.source.path).toBe("/embedded");
    expect(report.source.blockedRequests).toBeGreaterThanOrEqual(1);
    expect(report.status).toBe("captured");
    expect(report.artifacts.current).toBeDefined();
  });

  it("8. detects a real UI change in the application as a measurable regression", async () => {
    await app.applyUiChange();
    const html = await (await fetch(`${app.url}/`)).text();
    expect(html).toContain("$51,940");

    await selectSource(/^Overview/);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("regression");
    expect(verdict.percent).toBeGreaterThan(0.1);
    expect(verdict.percent).toBeLessThan(25);
    regressionPercent = verdict.percent!;

    const report = await fetchRun((await readDisplayedRunId(page))!);
    regressionRunId = report.id;
    expect(report.mode).toBe("baseline");
    expect(report.status).toBe("regression");
    expect(report.baseline?.versionId).toBe(approvedVersionId);
    expect(report.source.projectId).toBe(PROJECT_ID);
    expect(report.metrics.changedPixels).toBeGreaterThan(0);
    expect(report.metrics.changePercentage).toBeCloseTo(
      (report.metrics.changedPixels / report.metrics.comparedPixels) * 100,
      6,
    );

    // The diff image is real, and its counted pixels are the reported ones.
    const diff = await apiBytes(`/api/artifacts/${report.id}/diff.png`);
    expect(diff.status).toBe(200);
    const decoded = PNG.sync.read(diff.bytes);
    let diffColored = 0;
    for (let index = 0; index < decoded.data.length; index += 4) {
      if (decoded.data[index] === 220 && decoded.data[index + 1] === 38 && decoded.data[index + 2] === 38) {
        diffColored += 1;
      }
    }
    expect(diffColored).toBe(report.metrics.changedPixels);

    // A regression never approves itself: the baseline history is untouched.
    const baseline = await fetchProjectBaseline();
    expect(baseline?.versions).toHaveLength(1);
    expect(baseline?.activeVersionId).toBe(approvedVersionId);
  });

  it("9. passes again once the application's original UI is restored", async () => {
    await app.restoreUi();
    const html = await (await fetch(`${app.url}/`)).text();
    expect(html).toContain("$48,200");

    await selectSource(/^Overview/);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);
    expect(verdict.percent).toBeLessThan(regressionPercent);

    const report = await fetchRun((await readDisplayedRunId(page))!);
    expect(report.metrics.changedPixels).toBe(0);
    expect(report.baseline?.versionId).toBe(approvedVersionId);
  });

  it("10. keeps the baseline and the run history across a UIProof restart", async () => {
    const runsBefore = (await api("/api/reports?limit=100")).body as { reports: Array<{ id: string }> };
    const idsBefore = runsBefore.reports.map((entry) => entry.id);

    const portBefore = uiproof.runtime.port;
    await uiproof.stop();
    uiproof = await startUiProof({
      registrations: [{ ...REGISTRATION[0], origin: app.url }],
      dirs: scratchDirs,
      ports: [portBefore, ...PROJECT_SERVER_PORTS],
      label: "UIProof (after restart)",
      dir: dataDir,
    });
    base = uiproof.runtime.url;
    // A new process, pointed at the same data directory — not the same server.
    expect(uiproof.runtime.dataDir).toBe(dataDir);
    expect(uiproof.runtime.port).toBe(portBefore);

    // The baseline is still the same version, and every run is still on disk.
    const baseline = await fetchProjectBaseline();
    expect(baseline?.activeVersionId).toBe(approvedVersionId);
    expect(baseline?.versions).toHaveLength(1);
    const runsAfter = (await api("/api/reports?limit=100")).body as { reports: Array<{ id: string }> };
    const idsAfter = runsAfter.reports.map((entry) => entry.id);
    for (const id of idsBefore) expect(idsAfter).toContain(id);
    expect(idsAfter).toContain(captureRunId);
    expect(idsAfter).toContain(regressionRunId);

    // And the restarted server still detects drift against it correctly.
    await openConsole();
    await selectSource(/^Overview/);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);
  }, 240_000);

  it("11. refuses unregistered sources, off-origin redirects and unsafe configuration", async () => {
    // A project that is not in the registration file does not exist.
    const unknownProject = await compare({ source: { kind: "project", projectId: "not-registered", routeId: "home" } });
    expect(unknownProject.status).toBe(400);
    expect((unknownProject.body as { error: { code: string } }).error.code).toBe("project_not_registered");

    // Neither does a route the file does not name — including a traversal attempt.
    const unknownRoute = await compare({
      source: { kind: "project", projectId: PROJECT_ID, routeId: "../../etc/passwd" },
    });
    expect(unknownRoute.status).toBe(400);
    expect((unknownRoute.body as { error: { code: string } }).error.code).toBe("route_not_registered");

    // Arbitrary URLs are still refused, exactly as in Phase 1.
    const arbitrary = await compare({ targetId: "https://evil.example", viewportId: VIEWPORT });
    expect(arbitrary.status).toBe(400);
    expect((arbitrary.body as { error: { code: string } }).error.code).toBe("invalid_target");

    // A registered route whose page redirects to a public origin is refused, and nothing
    // is stored for it.
    const runsBefore = (await api("/api/reports?limit=100")).body as { reports: Array<{ id: string }> };
    const redirecting = await compare({
      source: { kind: "project", projectId: PROJECT_ID, routeId: "redirects-away" },
      viewportId: VIEWPORT,
    });
    expect(redirecting.status).toBe(502);
    expect((redirecting.body as { error: { code: string } }).error.code).toBe("capture_redirected");
    const runsAfter = (await api("/api/reports?limit=100")).body as { reports: Array<{ id: string }> };
    expect(runsAfter.reports.length).toBe(runsBefore.reports.length);

    // Approval stays a local, same-origin operation.
    const crossSite = await api("/api/baselines", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({
        source: { kind: "project", projectId: PROJECT_ID, routeId: "overview" },
        viewportId: VIEWPORT,
        sourceReportId: captureRunId,
      }),
    });
    expect(crossSite.status).toBe(403);

    // A registration file with an unsafe route path is rejected as a whole, with a reason.
    const unsafeServer = await startUiProof({
      registrations: UNSAFE_REGISTRATION,
      dirs: scratchDirs,
      ports: [3320, 3321],
      label: "UIProof (unsafe config)",
    });
    try {
      const unsafeCatalog = await fetch(`${unsafeServer.runtime.url}/api/catalog`, { cache: "no-store" });
      const unsafeBody = (await unsafeCatalog.json()) as {
        projects: unknown[];
        projectConfigError: string | null;
      };
      expect(unsafeBody.projects).toEqual([]);
      expect(unsafeBody.projectConfigError).toMatch(/path/i);

      const unsafeCompare = await fetch(`${unsafeServer.runtime.url}/api/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: unsafeServer.runtime.url },
        body: JSON.stringify({ source: { kind: "project", projectId: "sneaky", routeId: "escape" } }),
      });
      expect(unsafeCompare.status).toBe(500);
      expect(((await unsafeCompare.json()) as { error: { code: string } }).error.code).toBe("project_config_invalid");
    } finally {
      await unsafeServer.stop();
    }

    // A development server that is not listening produces an actionable 502, not a hang.
    const deadPort = await pickFreePort([4987, 4988]);
    const deadServer = await startUiProof({
      registrations: [{ id: "not-running", name: "Not running", origin: `http://127.0.0.1:${deadPort}`, routes: [{ id: "home", name: "Home", path: "/" }] }],
      dirs: scratchDirs,
      ports: [3322, 3323],
      label: "UIProof (unreachable app)",
    });
    try {
      const unreachable = await fetch(`${deadServer.runtime.url}/api/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: deadServer.runtime.url },
        body: JSON.stringify({ source: { kind: "project", projectId: "not-running", routeId: "home" } }),
      });
      expect(unreachable.status).toBe(502);
      const body = (await unreachable.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("project_unreachable");
      expect(body.error.message).toContain(`127.0.0.1:${deadPort}`);
    } finally {
      await deadServer.stop();
    }
  }, 240_000);
});
