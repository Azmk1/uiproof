import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import {
  eventually,
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
 * The baseline lifecycle, driven the way a developer would drive it: run a comparison,
 * approve it, then watch drift appear and disappear. Every comparison captures a real
 * page in Chromium and every approval moves real PNG bytes on disk.
 *
 * 1. no baseline exists
 * 2. capture and approve a baseline (through the UI, with its confirmation step)
 * 3. run against an unchanged page and pass
 * 4. introduce a deliberate change and detect a regression
 * 5. restore the original page and pass again
 * 6. replace then restore an approved baseline explicitly
 * 7. reload the application and confirm everything persists
 */
describe("baseline lifecycle", () => {
  const target = "invoice-summary";
  const viewport = "desktop";

  let browser: Browser;
  let page: Page;
  let firstVersionId = "";
  let driftVersionId = "";
  let driftRunId = "";
  let passedRunId = "";

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await openConsole(browser);
  });

  afterAll(async () => {
    await page.context().close();
    await browser.close();
  });

  it("1. starts with no approved baseline for this target and viewport", async () => {
    await expectText(page.locator('[aria-label="Approved baseline"]'), /Nothing has been approved/i);
    expect(await fetchBaseline(target, viewport)).toBeNull();
  });

  it("2. captures a run and approves it as the baseline through the UI", async () => {
    const verdict = await runComparison(page, "fixture");
    expect(verdict.percent).toBeGreaterThan(0);

    const runId = await readDisplayedRunId(page);
    expect(runId).not.toBeNull();

    // Approval is a two-step action: the button opens a confirmation, nothing happens
    // until it is confirmed.
    await page.getByRole("button", { name: /Approve this run as the baseline/i }).click();
    await expectVisible(page.getByText(new RegExp(`Approve run ${runId}`)));
    await page.getByRole("button", { name: /Yes, approve it/i }).click();

    await eventually(async () => (await fetchBaseline(target, viewport)) !== null, {
      message: "the baseline was never stored",
    });
    const baseline = await fetchBaseline(target, viewport);
    expect(baseline?.versions).toHaveLength(1);
    expect(baseline?.activeVersionId).toBe(baseline?.versions[0].id);
    expect(baseline?.versions[0].sourceReportId).toBe(runId);
    expect(baseline?.versions[0].capturedRoute).toBe("/demo/current");
    firstVersionId = baseline!.versions[0].id;

    // The approved image is already served as a real PNG.
    const image = await fetchArtifactStatus(`/api/baselines/${target}/${viewport}/${firstVersionId}.png`);
    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    expect(image.bytes).toBeGreaterThan(1000);

    // And the panel now shows it as active, naming the run it came from.
    const panel = page.locator('[aria-label="Approved baseline"]');
    await expectText(panel, /active/i);
    await expectText(panel, new RegExp(runId!));
  });

  it("3. passes against the approved baseline while the page is unchanged", async () => {
    await selectMode(page, /Approved baseline/i);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);

    const runId = await readDisplayedRunId(page);
    const stored = await fetchRun(runId!);
    expect(stored.mode).toBe("baseline");
    expect(stored.metrics.changedPixels).toBe(0);
    expect(stored.metrics.comparedPixels).toBe(1024000);
    expect(stored.baseline?.versionId).toBe(firstVersionId);
    passedRunId = stored.id;
  });

  it("4. detects the regression once the page changes", async () => {
    await selectVariant(page, /Reverted page/i);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("regression");
    expect(verdict.percent).toBeGreaterThan(0);

    const runId = await readDisplayedRunId(page);
    const stored = await fetchRun(runId!);
    expect(stored.metrics.changedPixels).toBeGreaterThan(0);
    expect(stored.baseline?.versionId).toBe(firstVersionId);
    expect(stored.target.currentPath).toBe("/demo/reverted");
    driftRunId = stored.id;
    expect(passedRunId).not.toBe(driftRunId);
  });

  it("5. passes again after the page is restored", async () => {
    await selectVariant(page, /Shipped page/i);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);

    const stored = await fetchRun((await readDisplayedRunId(page))!);
    expect(stored.metrics.changedPixels).toBe(0);
    expect(stored.baseline?.versionId).toBe(firstVersionId);
  });

  it("6. replaces the baseline with a new version and restores the older one", async () => {
    // Approve the run that captured the changed page: a new version, not an overwrite.
    await selectVariant(page, /Reverted page/i);
    await runComparison(page, "baseline");
    const driftRun = await readDisplayedRunId(page);
    await page.getByRole("button", { name: /Approve this run as a new version/i }).click();
    await page.getByRole("button", { name: /Yes, approve it/i }).click();

    await eventually(async () => (await fetchBaseline(target, viewport))?.versions.length === 2, {
      message: "the second version was never stored",
    });
    const replaced = await fetchBaseline(target, viewport);
    expect(replaced?.versions).toHaveLength(2);
    driftVersionId = replaced!.activeVersionId!;
    expect(driftVersionId).not.toBe(firstVersionId);
    expect(replaced?.versions[1].sourceReportId).toBe(driftRun);

    // The first image is still on disk, unchanged: approval never rewrites history.
    expect(await fetchArtifactStatus(`/api/baselines/${target}/${viewport}/${firstVersionId}.png`)).toMatchObject({
      status: 200,
    });

    // Restore the original version through the UI, including its confirmation.
    await page.getByRole("button", { name: /^Restore$/ }).first().click();
    await page.getByRole("button", { name: /Restore it/i }).click();
    await eventually(async () => (await fetchBaseline(target, viewport))?.activeVersionId === firstVersionId, {
      message: "the older version was never restored",
    });

    const restored = await fetchBaseline(target, viewport);
    expect(restored?.versions).toHaveLength(2);
    expect(restored?.activeVersionId).toBe(firstVersionId);
    expect(restored!.revision).toBeGreaterThanOrEqual(3);

    // With the original reference back, the shipped page passes again.
    await selectVariant(page, /Shipped page/i);
    const verdict = await runComparison(page, "baseline");
    expect(verdict.status).toBe("pass");
    expect(verdict.percent).toBe(0);
  });

  it("7. keeps baselines, history and the timeline after a reload", async () => {
    const runsBefore = await readHistoryCount(page);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /catch every drift/i }).waitFor();

    await eventually(async () => (await fetchBaseline(target, viewport)) !== null, {
      message: "the baseline did not survive the reload",
    });
    const baseline = await fetchBaseline(target, viewport);
    expect(baseline?.versions.map((version) => version.id)).toEqual([firstVersionId, driftVersionId]);
    expect(baseline?.activeVersionId).toBe(firstVersionId);

    await expectText(page.locator('[aria-label="Approved baseline"]'), /2 versions/i);
    await eventually(async () => (await readHistoryCount(page)) === runsBefore, {
      message: "the run history did not survive the reload",
    });

    // The timeline is rebuilt from the stored runs, including the regression.
    await expectText(page.locator('[aria-label="Comparison timeline"]'), /run/i);
    const verdict = await readVerdict(page);
    expect(verdict.percent).not.toBeNull();
  });
});
