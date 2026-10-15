import type { Page } from "playwright";
import { getBrowser } from "./browser";
import { ComparisonError } from "./errors";
import type { ViewportPreset } from "./types";

export interface CaptureInput {
  readonly url: URL;
  readonly viewport: ViewportPreset;
  readonly timeoutMs?: number;
}

export interface CaptureResult {
  readonly png: Buffer;
  readonly durationMs: number;
  readonly browser: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function waitForStableLayout(page: Page): Promise<void> {
  // Fonts must be resolved before the screenshot or text metrics drift between runs.
  await page
    .evaluate(() => document.fonts.ready.then(() => undefined))
    .catch(() => undefined);
  await page
    .waitForFunction(
      () => Array.from(document.images).every((image) => image.complete),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

/**
 * Renders one allow-listed local route in Chromium and returns a viewport-sized
 * PNG. Capture conditions are pinned (light colour scheme, reduced motion,
 * animations disabled) so an unchanged page always produces an identical image.
 */
export async function capturePage(input: CaptureInput): Promise<CaptureResult> {
  const { url, viewport } = input;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browser = await getBrowser();
  const startedAt = Date.now();

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });

  try {
    const page = await context.newPage();
    const response = await page.goto(url.toString(), { waitUntil: "load", timeout });
    if (response && !response.ok()) {
      throw new ComparisonError(
        "capture_failed",
        `Fixture ${url.pathname} responded with HTTP ${response.status()}`,
      );
    }
    await waitForStableLayout(page);
    const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    return { png, durationMs: Date.now() - startedAt, browser: "chromium" };
  } catch (error) {
    if (error instanceof ComparisonError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ComparisonError("capture_failed", `Failed to capture ${url.pathname}: ${message}`, {
      cause: error,
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}
