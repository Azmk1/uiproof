import type { Browser, Locator, Page } from "playwright";
import { chromium } from "playwright";
import { readE2eRuntime } from "./e2e-server";

/** Shared plumbing for the browser suite. Everything here talks to a real server. */

export interface Verdict {
  readonly raw: string;
  readonly status: "regression" | "pass" | "unknown";
  readonly percent: number | null;
  readonly mode: "fixture" | "baseline" | "unknown";
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}

export function baseUrl(): string {
  return readE2eRuntime().url;
}

/** Polls a predicate (or an async page function) until it holds, then returns its value. */
export async function eventually<T>(
  probe: () => Promise<T> | T,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly message?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError ? `last error: ${String(lastError)}` : `last value: ${JSON.stringify(last)}`;
  throw new Error(`${options.message ?? "Condition was not met"} within ${timeoutMs}ms (${detail})`);
}

/**
 * Assertions for the browser suite.
 *
 * The suite uses the Playwright library with Vitest rather than `@playwright/test`, so
 * it keeps the project's single test runner and adds no dependency; these three helpers
 * cover the retrying assertions that matter here.
 */
export async function expectVisible(locator: Locator, message?: string): Promise<void> {
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(message ?? `Expected ${locator} to be visible`);
  }
}

export async function expectHidden(locator: Locator, message?: string): Promise<void> {
  try {
    await locator.waitFor({ state: "hidden", timeout: 15_000 });
  } catch {
    throw new Error(message ?? `Expected ${locator} to disappear`);
  }
}

/** Waits until the element's text matches, then returns the matching text. */
export async function expectText(locator: Locator, pattern: RegExp): Promise<string> {
  const matched = await eventually<string | null>(
    async () => {
      const text = await locator.innerText();
      return pattern.test(text) ? text : null;
    },
    { timeoutMs: 20_000, message: `Expected ${String(pattern)} in the element text` },
  );
  return matched ?? "";
}

export async function expectEnabled(locator: Locator): Promise<void> {
  await eventually(async () => await locator.isEnabled(), { message: "Expected the control to be enabled" });
}

export async function expectDisabled(locator: Locator): Promise<void> {
  await eventually(async () => await locator.isDisabled(), { message: "Expected the control to be disabled" });
}

export async function openConsole(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(baseUrl(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /catch every drift|catch visual regressions/i }).waitFor();
  return page;
}

/**
 * Makes sure the console is showing a stored report, running a real comparison if the
 * data directory is still empty. Keeps the suites independent of file order: whichever
 * runs first produces the report, and the rest measure the fully populated dashboard.
 */
export async function ensureReport(page: Page): Promise<void> {
  await expectEnabled(page.getByRole("button", { name: /Run comparison/i }));
  try {
    await page.locator('[aria-label="Captured artifacts"]').waitFor({ state: "visible", timeout: 5_000 });
    return;
  } catch {
    // Nothing stored yet, so the dashboard is still in its empty state.
  }
  await runComparison(page, "fixture");
  await expectVisible(page.locator('[aria-label="Captured artifacts"]'));
}

/** Reads the verdict panel: status, percentage and which mode produced it. */
export async function readVerdict(page: Page): Promise<Verdict> {
  return page.evaluate(() => {
    const section = document.querySelector('[aria-label="Comparison verdict"]');
    const text = (section?.textContent ?? "").replace(/\s+/g, " ").trim();
    const percentMatch = text.match(/([\d.,]+)%\s*of the viewport changed/);
    const status = /regression/i.test(text) ? "regression" : /no changes/i.test(text) ? "pass" : "unknown";
    const mode = /approved baseline/i.test(text)
      ? "baseline"
      : /fixture pair/i.test(text)
        ? "fixture"
        : "unknown";
    return {
      raw: text.slice(0, 400),
      status,
      percent: percentMatch ? Number(percentMatch[1].replace(/,/g, "")) : null,
      mode,
    };
  });
}

/**
 * Selects a mode, clicks "Run comparison" and waits until the verdict reflects the
 * finished run. The mode is always selected explicitly so one test cannot leak its mode
 * into the next one.
 */
export async function runComparison(page: Page, expectedMode: "fixture" | "baseline"): Promise<Verdict> {
  await selectMode(page, expectedMode === "fixture" ? /Fixture pair/i : /Approved baseline/i);
  await expectEnabled(page.getByRole("button", { name: /Run comparison/i }));

  const historyCountBefore = await readHistoryCount(page);
  await page.getByRole("button", { name: /Run comparison/i }).click();

  // Wait for the engine to finish: the stored history grows by exactly one entry.
  await eventually(async () => (await readHistoryCount(page)) > historyCountBefore, {
    timeoutMs: 60_000,
    message: "The run never appeared in the history",
  });
  await eventually(
    async () => {
      const verdict = await readVerdict(page);
      return verdict.status !== "unknown" && verdict.percent !== null ? verdict : null;
    },
    { timeoutMs: 30_000, message: "The verdict panel did not report a finished comparison" },
  );

  const verdict = await readVerdict(page);
  if (verdict.mode !== expectedMode) {
    throw new Error(`Expected a ${expectedMode} verdict, saw ${verdict.mode}: ${verdict.raw}`);
  }
  return verdict;
}

/** The "N stored" figure in the run history header. */
export async function readHistoryCount(page: Page): Promise<number> {
  const text = await page.locator('[aria-label="Run history"] header span').last().textContent();
  const match = (text ?? "").match(/(\d+)\s*stored/);
  return match ? Number(match[1]) : 0;
}

/** The run id the verdict panel is currently showing. */
export async function readDisplayedRunId(page: Page): Promise<string | null> {
  const raw = await page
    .locator('[aria-label="Comparison verdict"]')
    .textContent()
    .catch(() => null);
  const match = (raw ?? "").match(/run-[0-9a-f-]{36}/);
  return match ? match[0] : null;
}

/** Selects a comparison mode by its visible label. */
export async function selectMode(page: Page, label: RegExp): Promise<void> {
  await page.getByRole("radio", { name: label }).check();
}

/** Selects a page state (variant) by its visible label. */
export async function selectVariant(page: Page, label: RegExp): Promise<void> {
  await page.getByRole("radio", { name: label }).check();
}

export async function selectViewport(page: Page, label: string): Promise<void> {
  await page.getByRole("radio", { name: label, exact: true }).check();
}

export interface BaselineView {
  activeVersionId: string | null;
  versions: Array<{ id: string; capturedRoute: string; sourceReportId: string; approvedAt: string }>;
  revision: number;
}

/** Reads the approved baseline straight from the API — the same data the panel shows. */
export async function fetchBaseline(targetId: string, viewportId: string): Promise<BaselineView | null> {
  const response = await fetch(`${baseUrl()}/api/baselines/${targetId}/${viewportId}`);
  if (!response.ok) throw new Error(`GET /api/baselines failed with HTTP ${response.status}`);
  const body = (await response.json()) as { baseline: BaselineView | null };
  return body.baseline;
}

export interface StoredRun {
  id: string;
  status: string;
  mode?: string;
  variantId?: string | null;
  metrics: { changedPixels: number; comparedPixels: number; changePercentage: number };
  baseline?: { versionId: string } | null;
  target: { id: string; currentPath: string };
  viewport: { id: string };
}

export async function fetchRun(reportId: string): Promise<StoredRun> {
  const response = await fetch(`${baseUrl()}/api/reports/${reportId}`);
  if (!response.ok) throw new Error(`GET /api/reports/${reportId} failed with HTTP ${response.status}`);
  const body = (await response.json()) as { report: StoredRun };
  return body.report;
}

export async function fetchArtifactStatus(url: string): Promise<{ status: number; contentType: string; bytes: number }> {
  const response = await fetch(url.startsWith("http") ? url : `${baseUrl()}${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: buffer.byteLength,
  };
}
