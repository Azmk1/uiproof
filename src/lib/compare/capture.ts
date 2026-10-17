import type { Page } from "playwright";
import { getBrowser } from "./browser";
import { ComparisonError } from "./errors";
import type { ViewportPreset } from "./types";

/**
 * One page, one viewport, one PNG.
 *
 * Phase 3 widened this from "our own demo fixtures" to "any registered local
 * application", which changes what has to be defended:
 *
 *  · **The browser may only talk to approved origins.** A route handler aborts every
 *    request that leaves the target origin plus the project's explicitly allowed
 *    origins, and the capture reports how many it refused. A capture is hermetic unless
 *    a developer widens it on purpose.
 *  · **A redirect cannot move the capture.** The page itself must land on the origin it
 *    was registered under: a redirect to anywhere else fails the capture with
 *    `capture_redirected`, whether the browser followed it to the end or the network
 *    guard refused the hop. Registering the destination as its own route is the way to
 *    capture it deliberately.
 *  · **An unreachable server is a named error, not a mystery.** A cheap preflight
 *    request turns "nothing is listening" into a message that says which origin and
 *    what to do about it, before Chromium is even launched.
 *
 * The deterministic conditions Phase 1 pinned are unchanged: fixed viewport and colour
 * scheme, reduced motion, animations disabled, carets hidden, fonts and images awaited.
 */

export interface CaptureInput<TInspection = null> {
  readonly url: URL;
  readonly viewport: ViewportPreset;
  readonly timeoutMs?: number;
  /** Extra origins the page may load from, on top of the captured origin itself. */
  readonly allowedOrigins?: readonly string[];
  /** Human label used in errors, e.g. `Example app · Home`. */
  readonly label?: string;
  /** Preflight the target first, so an unreachable server fails fast and clearly. */
  readonly probe?: boolean;
  /**
   * Measure the captured page before its context closes — the quality checks use this to
   * run axe and the responsive audit against the exact rendering the screenshot came from.
   * The screenshot is taken first, so an inspector can never change the pixels; `durationMs`
   * stays the capture's own time and an inspector times itself.
   */
  readonly inspect?: (page: Page) => Promise<TInspection>;
}

export interface CaptureResult<TInspection = null> {
  readonly png: Buffer;
  readonly durationMs: number;
  readonly browser: string;
  /** Requests refused because they left the approved origins. */
  readonly blockedRequests: number;
  readonly blockedOrigins: readonly string[];
  /** What `inspect` measured, or `null` when nothing was asked. */
  readonly inspection: TInspection | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 4_000;

/** Schemes a page may always use: no network, no origin to approve. */
const ORIGINLESS_SCHEMES = new Set(["data:", "blob:", "about:", "javascript:", "chrome-error:"]);

const UNREACHABLE_PATTERNS = [
  /ERR_CONNECTION_REFUSED/i,
  /ERR_CONNECTION_RESET/i,
  /ERR_CONNECTION_TIMED_OUT/i,
  /ERR_ADDRESS_UNREACHABLE/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_EMPTY_RESPONSE/i,
  /ECONNREFUSED/i,
  /Timeout \d+ms exceeded/i,
];

function originOf(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (ORIGINLESS_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function unreachable(url: URL, label: string, cause: unknown): ComparisonError {
  return new ComparisonError(
    "project_unreachable",
    `Nothing answered at ${url.origin} while capturing ${label}. Start the application (and check its port), then run again.`,
    { cause },
  );
}

/**
 * A single bounded request before Chromium starts. It exists for the error message, not
 * for correctness: the navigation below fails on its own if the server is down.
 */
async function probeReachable(url: URL, label: string): Promise<void> {
  try {
    await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "uiproof-preflight" },
    });
  } catch (cause) {
    throw unreachable(url, label, cause);
  }
}

function redirectedAway(label: string, expectedOrigin: string, landedOn: string): ComparisonError {
  return new ComparisonError(
    "capture_redirected",
    `${label} redirected to ${landedOn}, which is not the origin it is registered under (${expectedOrigin}). Register the destination as its own route if it is a page you want to capture.`,
  );
}

async function waitForStableLayout(page: Page): Promise<void> {
  // Fonts must be resolved before the screenshot or text metrics drift between runs.
  await page
    .evaluate(() => document.fonts.ready.then(() => undefined))
    .catch(() => undefined);
  await page
    .waitForFunction(() => Array.from(document.images).every((image) => image.complete), undefined, {
      timeout: 5_000,
    })
    .catch(() => undefined);
}

export async function capturePage<TInspection = null>(
  input: CaptureInput<TInspection>,
): Promise<CaptureResult<TInspection>> {
  const { url, viewport } = input;
  const label = input.label ?? url.pathname;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectedOrigin = url.origin;
  const approvedOrigins = new Set<string>([expectedOrigin, ...(input.allowedOrigins ?? [])]);

  if (input.probe !== false) await probeReachable(url, label);

  const browser = await getBrowser();
  const startedAt = Date.now();
  const blockedOrigins = new Set<string>();
  let blockedRequests = 0;
  /** A navigation the guard refused — the page tried to leave its registered origin. */
  let blockedNavigationOrigin: string | null = null;

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
    // Restrict the browser's network access to the approved origins by default.
    await context.route("**/*", async (route) => {
      const requestOrigin = originOf(route.request().url());
      if (requestOrigin === null || approvedOrigins.has(requestOrigin)) {
        await route.continue();
        return;
      }
      if (route.request().isNavigationRequest()) blockedNavigationOrigin ??= requestOrigin;
      blockedRequests += 1;
      blockedOrigins.add(requestOrigin);
      await route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(url.toString(), { waitUntil: "load", timeout });
    } catch (cause) {
      // A refused navigation hop is how an off-origin redirect usually ends: the guard
      // aborts the request before Chromium can render anything. Name it precisely.
      const escaped = blockedNavigationOrigin ?? originOf(page.url());
      if (escaped !== null && escaped !== expectedOrigin) {
        throw redirectedAway(label, expectedOrigin, escaped);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(message))) {
        throw unreachable(url, label, cause);
      }
      throw new ComparisonError("capture_failed", `Failed to capture ${label}: ${message}`, { cause });
    }

    // A redirect that landed somewhere else is a refusal, not a screenshot.
    const landedOn = originOf(page.url());
    if (landedOn !== expectedOrigin) {
      throw redirectedAway(label, expectedOrigin, landedOn ?? page.url());
    }

    if (response && !response.ok()) {
      throw new ComparisonError("capture_failed", `${label} responded with HTTP ${response.status()}`);
    }

    await waitForStableLayout(page);
    const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    const captureMs = Date.now() - startedAt;
    const inspection = input.inspect ? await input.inspect(page) : null;
    return {
      png,
      durationMs: captureMs,
      browser: "chromium",
      blockedRequests,
      blockedOrigins: [...blockedOrigins].sort(),
      inspection,
    };
  } catch (error) {
    if (error instanceof ComparisonError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ComparisonError("capture_failed", `Failed to capture ${label}: ${message}`, { cause: error });
  } finally {
    await context.close().catch(() => undefined);
  }
}
