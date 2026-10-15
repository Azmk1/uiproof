import { chromium, type Browser } from "playwright";
import { ComparisonError } from "./errors";

/**
 * One Chromium instance is shared by every comparison so a run costs a page
 * context instead of a full browser launch. Idle instances are closed again so
 * a long-lived dev server never leaves orphaned Chromium processes behind.
 */

const IDLE_TIMEOUT_MS = 60_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function cancelIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleClose(): void {
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    void closeBrowser();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      // Deterministic rendering across runs: fixed colour profile, no LCD text
      // sub-pixel anti-aliasing, and no scrollbars in the capture.
      args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"],
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
      throw new ComparisonError(
        "browser_unavailable",
        "Chromium is not installed for Playwright. Run `pnpm setup:browser` and try again.",
        { cause },
      );
    }
    throw new ComparisonError("browser_unavailable", `Could not start Chromium: ${message}`, { cause });
  }
}

export async function getBrowser(): Promise<Browser> {
  cancelIdleClose();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!browserPromise) browserPromise = launchBrowser();
    try {
      const browser = await browserPromise;
      if (browser.isConnected()) {
        scheduleIdleClose();
        return browser;
      }
    } catch (error) {
      browserPromise = null;
      throw error;
    }
    browserPromise = null;
  }
  throw new ComparisonError("browser_unavailable", "Chromium disconnected before a capture could start.");
}

export async function closeBrowser(): Promise<void> {
  cancelIdleClose();
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    if (browser.isConnected()) await browser.close();
  } catch {
    /* the browser was already gone — nothing to clean up */
  }
}
