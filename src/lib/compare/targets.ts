import type { ComparisonTarget, ViewportPreset } from "./types";

/** Viewport presets available to the dashboard. Both captures of a run always use the same preset. */
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "desktop", label: "Desktop", width: 1280, height: 800, deviceScaleFactor: 1 },
  { id: "tablet", label: "Tablet", width: 834, height: 1112, deviceScaleFactor: 1 },
  { id: "mobile", label: "Mobile", width: 390, height: 844, deviceScaleFactor: 1 },
];

export const DEFAULT_VIEWPORT_ID = "desktop";

export function getViewport(id: unknown): ViewportPreset | undefined {
  if (typeof id !== "string") return undefined;
  return VIEWPORT_PRESETS.find((preset) => preset.id === id);
}

/**
 * Only routes under this prefix may be screenshotted. UIProof intentionally
 * refuses arbitrary URLs so it can never act as an open screenshot service.
 */
export const DEMO_ROUTE_PREFIX = "/demo/";

const SAFE_DEMO_ROUTE = /^\/demo\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/;
const MAX_ROUTE_LENGTH = 120;

/**
 * Strict allow-list check for a capturable route. Rejects absolute URLs,
 * protocol-relative paths, traversal, query strings, fragments and anything
 * outside the local /demo fixtures.
 */
export function isAllowedDemoRoute(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_ROUTE_LENGTH) return false;
  if (!path.startsWith(DEMO_ROUTE_PREFIX)) return false;
  if (
    path.includes("..") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("//") ||
    path.includes(" ")
  ) {
    return false;
  }
  return SAFE_DEMO_ROUTE.test(path);
}

/**
 * Builds the absolute capture URL for an allow-listed route and proves the
 * result still points at the UIProof origin (no redirect, no host override).
 */
export function buildCaptureUrl(origin: string, path: unknown): URL {
  if (!isAllowedDemoRoute(path)) {
    throw new RangeError(`Refusing to capture untrusted route: ${String(path)}`);
  }
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new RangeError(`Unsupported capture origin protocol: ${base.protocol}`);
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.pathname !== path) {
    throw new RangeError(`Capture URL escaped the UIProof origin: ${url.toString()}`);
  }
  return url;
}

export const COMPARISON_TARGETS: readonly ComparisonTarget[] = [
  {
    id: "invoice-summary",
    label: "Invoice summary card",
    summary:
      "The shipping fixture pair. Two versions of the same screen with deliberate regressions in copy, colour, layout and navigation.",
    baseline: { path: "/demo/baseline", label: "Baseline · v1" },
    current: { path: "/demo/current", label: "Current · v2" },
    expectedChanges: [
      "Navigation item removed from the fixture header",
      "Card heading weight and letter-spacing changed",
      "Total amount changed",
      "Primary action colour changed and its label reworded",
      "New “Save 10%” ribbon added to the card",
    ],
    expectedOutcome: "Expect a regression well above the 0.1% default tolerance.",
  },
  {
    id: "baseline-control",
    label: "Control · same page twice",
    summary:
      "Captures the baseline fixture twice. Proves the engine reports zero changed pixels when nothing changed — no false positives.",
    baseline: { path: "/demo/baseline", label: "Baseline · v1" },
    current: { path: "/demo/baseline", label: "Baseline · v1" },
    expectedChanges: [],
    expectedOutcome: "Expect exactly 0 changed pixels and a passing verdict.",
  },
];

export function getTarget(id: unknown): ComparisonTarget | undefined {
  if (typeof id !== "string") return undefined;
  return COMPARISON_TARGETS.find((target) => target.id === id);
}
