import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import {
  baseUrl,
  eventually,
  expectDisabled,
  expectEnabled,
  expectText,
  expectVisible,
  fetchArtifactStatus,
  fetchBaseline,
  fetchRun,
  launchBrowser,
  openConsole,
  readDisplayedRunId,
  readHistoryCount,
  readVerdict,
  runComparison,
  selectMode,
  selectVariant,
} from "./support/helpers";

/**
 * The dashboard flow, exercised in a real browser against a real production server:
 * pick a mode, run a comparison, inspect the artifacts, reload and find the report.
 */
describe("dashboard smoke test", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await openConsole(browser);
  });

  afterAll(async () => {
    await page.context().close();
    await browser.close();
  });

  it("renders the console with its controls and no console errors", async () => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await expectVisible(page.getByRole("heading", { name: /catch every drift/i }));
    await expectVisible(page.getByRole("radio", { name: /Fixture pair/i }));
    await expectVisible(page.getByRole("radio", { name: /Approved baseline/i }));
    await expectVisible(page.locator('[aria-label="Approved baseline"]'));
    await expectVisible(page.locator('[aria-label="Comparison timeline"]'));
    await expectEnabled(page.getByRole("button", { name: /Run comparison/i }));

    expect(errors).toEqual([]);
  });

  it("reports whether a baseline exists and gates baseline mode on it", async () => {
    // This suite shares one data directory with the baseline suite, so it must not assume
    // either state. It asserts the invariant instead: the panel never says "nothing
    // approved" while a baseline is stored, and baseline mode only runs when one is.
    const panel = page.locator('[aria-label="Approved baseline"]');
    const panelText = await expectText(panel, /Nothing has been approved|\d+ version/i);
    const claimsBaseline = !/nothing has been approved/i.test(panelText);
    expect(claimsBaseline).toBe((await fetchBaseline("invoice-summary", "desktop")) !== null);

    await selectMode(page, /Approved baseline/i);
    const run = page.getByRole("button", { name: /Run comparison/i });
    if (claimsBaseline) {
      await expectEnabled(run);
    } else {
      await expectDisabled(run);
      await expectText(panel, /Nothing has been approved/i);
    }

    await selectMode(page, /Fixture pair/i);
    await expectEnabled(run);
  });

  it("runs a fixture comparison and shows a measured verdict", async () => {
    const verdict = await runComparison(page, "fixture");
    expect(verdict.status).toBe("regression");
    expect(verdict.percent).toBeGreaterThan(0);

    const runId = await readDisplayedRunId(page);
    expect(runId).toMatch(/^run-[0-9a-f-]{36}$/);

    // The stored report must agree with what the panel claims, and the metrics must be
    // internally consistent: percentage = changed / compared.
    const stored = await fetchRun(runId!);
    expect(stored.mode).toBe("fixture");
    expect(stored.metrics.changedPixels).toBeGreaterThan(0);
    expect(stored.metrics.changePercentage).toBeCloseTo(
      (stored.metrics.changedPixels / stored.metrics.comparedPixels) * 100,
      6,
    );

    // All three artifacts are real PNGs served by the API.
    for (const name of ["baseline", "current", "diff"] as const) {
      const artifact = await fetchArtifactStatus(`/api/artifacts/${stored.id}/${name}.png`);
      expect(artifact.status, `${name}.png`).toBe(200);
      expect(artifact.contentType).toBe("image/png");
      expect(artifact.bytes).toBeGreaterThan(1000);
    }
  });

  it("loads the screenshots into the viewer at their natural size", async () => {
    const image = page.locator('[aria-label="Captured artifacts"] img').first();
    await eventually(async () => (await image.getAttribute("width")) !== null, { message: "no artifact image" });
    const natural = await image.evaluate((node) => {
      const element = node as HTMLImageElement;
      return { complete: element.complete, width: element.naturalWidth, height: element.naturalHeight };
    });
    expect(natural.complete).toBe(true);
    expect(natural.width).toBe(1280);
    expect(natural.height).toBe(800);
  });

  it("reports zero drift, not a false positive, once the page state is reverted", async () => {
    // `/demo/reverted` renders the same screen as the `/demo/baseline` fixture, so the
    // fixture pair has to report exactly nothing. It is the cheapest possible check that
    // the diff is measured rather than guessed, and it proves the variant really did
    // change which route got captured.
    await selectVariant(page, /Reverted page/i);
    const verdict = await runComparison(page, "fixture");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);

    const runId = await readDisplayedRunId(page);
    const stored = await fetchRun(runId!);
    expect(stored.mode).toBe("fixture");
    expect(stored.variantId).toBe("reverted");
    expect(stored.target.currentPath).toBe("/demo/reverted");
    expect(stored.metrics.changedPixels).toBe(0);
    expect(stored.metrics.comparedPixels).toBe(1280 * 800);

    const diff = await fetchArtifactStatus(`/api/artifacts/${stored.id}/diff.png`);
    expect(diff.status).toBe(200);

    await selectVariant(page, /Shipped page/i);
    const shipped = await runComparison(page, "fixture");
    expect(shipped.status).toBe("regression");
    expect(shipped.percent).toBeGreaterThan(0);
  });

  it("keeps the report after a reload", async () => {
    await expectVisible(page.locator('[aria-label="Captured artifacts"]'));
    const before = await readDisplayedRunId(page);
    const countBefore = await readHistoryCount(page);
    expect(before).not.toBeNull();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /catch every drift/i }).waitFor();
    await eventually(async () => (await readDisplayedRunId(page)) === before, {
      message: "the stored report was not restored after a reload",
    });

    const verdict = await readVerdict(page);
    expect(verdict.percent).not.toBeNull();
    expect(await readHistoryCount(page)).toBe(countBefore);
  });

  it("keeps the project's capture guard closed", async () => {
    const response = await fetch(`${baseUrl()}/api/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl(), "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ targetId: "https://evil.example", viewportId: "desktop" }),
    });
    expect(response.status).toBe(400);
  });
});
