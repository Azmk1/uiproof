import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { eventually, expectVisible, launchBrowser } from "./support/helpers";
import { startE2eServer, type StartedE2eServer } from "./support/e2e-server";
import { startRepairApp, type RepairApp } from "./support/repair-app";
import {
  offeredIssueKeys,
  proposalJson,
  replaceLinePatch,
  startStubModel,
  type StubModel,
} from "./support/stub-model";

/**
 * The repair panel, in a real browser, against a real production server.
 *
 * The model is the only test double (a deterministic OpenAI-compatible stub). Everything
 * else is real: UIProof audits the fixture with Chromium and axe-core, the repair engine
 * copies the registered source, starts the sandbox server, applies the patch, re-measures,
 * runs the build and tests, and stores the evidence. The test then reads that evidence
 * back through the API the dashboard uses and confirms the source tree never moved.
 */

const PORTS = [3320, 3321, 3322, 3323];

describe("AI repair dashboard panel", () => {
  let app: RepairApp;
  let stub: StubModel;
  let uiproof: StartedE2eServer;
  let browser: Browser;
  let page: Page;
  let base = "";
  let dataDir = "";
  let original = "";
  const errors: string[] = [];

  beforeAll(async () => {
    app = await startRepairApp();
    original = await readFile(path.join(app.dir, "views", "index.html"), "utf8");
    stub = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.startsWith("a11y:label@"));
      if (!key) throw new Error("The repair prompt did not offer the missing-name issue");
      return proposalJson({
        issueKey: key,
        patch: replaceLinePatch(
          "views/index.html",
          original,
          '          <input id="email" type="email" autocomplete="email" />',
          ['          <input id="email" type="email" autocomplete="email" />', '          <label for="email">Email</label>'],
        ),
      });
    });

    dataDir = path.join(os.tmpdir(), `uiproof-repair-dashboard-${randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    const configPath = path.join(dataDir, "uiproof.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          projects: [
            {
              id: "repair-app",
              name: "Repair fixture",
              origin: app.url,
              routes: [
                { id: "support", name: "Support", path: "/" },
                { id: "manual", name: "Manual", path: "/manual" },
              ],
              sourceDir: app.dir,
              repair: {
                sandbox: {
                  command: ["node", "server.mjs"],
                  url: "http://127.0.0.1:4199",
                  readyPath: "/healthz",
                },
                build: ["node", "scripts/check-build.mjs"],
                test: ["node", "scripts/check-tests.mjs"],
                allow: ["views/**"],
                guardRoutes: ["manual"],
                entryFiles: ["views/index.html"],
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    uiproof = await startE2eServer({
      label: "repair dashboard",
      dataDir,
      portCandidates: PORTS,
      env: {
        UIPROOF_PROJECTS_FILE: configPath,
        UIPROOF_AI_API_KEY: "stub-key",
        UIPROOF_AI_BASE_URL: stub.baseUrl,
        UIPROOF_AI_MODEL: "stub-model",
      },
    });
    base = uiproof.runtime.url;

    browser = await launchBrowser();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /catch every drift/i }).waitFor();
  }, 180_000);

  afterAll(async () => {
    await page?.context().close();
    await browser?.close();
    await uiproof?.stop();
    await stub?.stop();
    await app?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("runs a repair from a failing audit and renders the verified evidence", async () => {
    // Produce the failing audit once, through the same HTTP endpoint the console calls.
    // The card loads the newest stored audit for the scope on mount, so the panel is
    // exercising its real "reload shows the stored result" path rather than a lucky click.
    const auditResponse = await fetch(`${base}/api/quality/audit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ source: { kind: "project", projectId: "repair-app", routeId: "support" } }),
    });
    expect(auditResponse.status).toBe(200);
    const audit = (await auditResponse.json()) as { report: { verdict: { status: string } } };
    expect(audit.report.verdict.status).toBe("fail");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("group", { name: "Source" }).getByRole("radio", { name: /^Support/ }).check();

    const repairPanel = page.locator('[aria-label="AI repair"]');
    await expectVisible(repairPanel, "the repair panel did not appear on the failing audit");

    const button = repairPanel.getByRole("button", { name: /Propose and verify a repair/i });
    await eventually(async () => await button.isEnabled(), {
      timeoutMs: 20_000,
      message: "the repair button stayed disabled although the model and sandbox are configured",
    });
    await button.click();

    const text = await eventually(async () => {
      const content = await repairPanel.innerText();
      return /verified/i.test(content) && /attempt 1/i.test(content) ? content : null;
    }, { timeoutMs: 120_000, message: "the repair never reached a verdict" });

    expect(text).toMatch(/Safe to review/);
    expect(text).toMatch(/unchanged — digest identical after the run/);
    expect(text).toMatch(/a11y:label@/);
    expect(text).toMatch(/label for="email"/);

    // The authoritative quality verdict is still a failure, and it is in its own panel.
    const auditPanel = page.locator('[aria-label="Quality audit"]');
    await expectVisible(auditPanel);
    expect(await auditPanel.innerText()).toMatch(/fail/i);

    // Before/after screenshots actually loaded from the repair artifact route.
    const images = repairPanel.locator("img");
    await eventually(async () => (await images.count()) >= 4, {
      timeoutMs: 20_000,
      message: "the before/after screenshots did not render",
    });
    const loaded = await images.evaluateAll((nodes) =>
      nodes.filter((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0).length,
    );
    expect(loaded).toBeGreaterThanOrEqual(4);

    const download = repairPanel.getByRole("link", { name: /Download this attempt's patch/i });
    const href = await download.getAttribute("href");
    expect(href).toContain("/api/repairs/");

    const patchResponse = await fetch(`${base}${href}`);
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.headers.get("content-type")).toContain("text/x-diff");
    expect(await patchResponse.text()).toContain('<label for="email">Email</label>');

    const list = await fetch(`${base}/api/repairs?scopeKey=${encodeURIComponent("project:repair-app/support")}`, {
      cache: "no-store",
    });
    expect(list.status).toBe(200);
    const payload = (await list.json()) as {
      repairs: Array<{ id: string; status: string; originalUnchanged: boolean }>;
      availability: { configured: boolean };
    };
    expect(payload.availability.configured).toBe(true);
    expect(payload.repairs).toHaveLength(1);
    expect(payload.repairs[0].status).toBe("verified");
    expect(payload.repairs[0].originalUnchanged).toBe(true);

    // The developer's application directory is exactly as it was.
    expect(await readFile(path.join(app.dir, "views", "index.html"), "utf8")).toBe(original);
    expect(errors).toEqual([]);
  }, 240_000);
});
