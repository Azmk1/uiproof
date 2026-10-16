import type { ComparisonMode, ComparisonTarget, FixtureVariantOption, ViewportPreset } from "./types";

/** Viewport presets available to the dashboard. Every capture of a run uses the same preset. */
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
 * outside the local /demo fixtures. Page states are separate routes, not query
 * parameters, so a capture URL carries no input the guard would have to inspect.
 */
export function isAllowedDemoRoute(route: unknown): route is string {
  if (typeof route !== "string") return false;
  if (route.length === 0 || route.length > MAX_ROUTE_LENGTH) return false;
  if (!route.startsWith(DEMO_ROUTE_PREFIX)) return false;
  if (
    route.includes("..") ||
    route.includes("\\") ||
    route.includes(":") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("//") ||
    route.includes(" ")
  ) {
    return false;
  }
  return SAFE_DEMO_ROUTE.test(route);
}

/**
 * Builds the absolute capture URL for an allow-listed route and proves the
 * result still points at the UIProof origin (no redirect, no host override).
 */
export function buildCaptureUrl(origin: string, route: unknown): URL {
  if (!isAllowedDemoRoute(route)) {
    throw new RangeError(`Refusing to capture untrusted route: ${String(route)}`);
  }
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new RangeError(`Unsupported capture origin protocol: ${base.protocol}`);
  }
  const url = new URL(route, base);
  if (url.origin !== base.origin || url.pathname !== route || url.search !== "") {
    throw new RangeError(`Capture URL escaped the UIProof origin: ${url.toString()}`);
  }
  return url;
}

/**
 * The states the invoice screen can be captured in. Each one is a real route, so the
 * engine never has to interpret input: `/demo/current` is the page as it ships today,
 * `/demo/reverted` is what it looks like once those changes are reverted. Switching
 * between them is exactly the drift a real code change produces.
 */
const SHIPPED_VARIANT: FixtureVariantOption = {
  id: "shipped",
  label: "Shipped page",
  route: "/demo/current",
  summary: "The page exactly as it ships today, deliberate regressions included.",
};

const REVERTED_VARIANT: FixtureVariantOption = {
  id: "reverted",
  label: "Reverted page",
  route: "/demo/reverted",
  summary: "The same screen with those changes reverted — what a fix looks like to the engine.",
};

export const COMPARISON_TARGETS: readonly ComparisonTarget[] = [
  {
    id: "invoice-summary",
    label: "Invoice summary card",
    summary:
      "The shipping fixture pair. Two versions of the same screen with deliberate regressions in copy, colour, layout and navigation. Supports both comparison modes, so it is also the drift-detection walkthrough.",
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
    // `capture` is available here too, so the demo fixtures exercise the same
    // single-screenshot path a registered project route uses.
    modes: ["fixture", "baseline", "capture"],
    defaultMode: "fixture",
    variants: [SHIPPED_VARIANT, REVERTED_VARIANT],
    defaultVariantId: SHIPPED_VARIANT.id,
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
    modes: ["fixture", "capture"],
    defaultMode: "fixture",
  },
];

export function getTarget(id: unknown): ComparisonTarget | undefined {
  if (typeof id !== "string") return undefined;
  return COMPARISON_TARGETS.find((target) => target.id === id);
}

export function targetSupportsMode(target: ComparisonTarget, mode: ComparisonMode): boolean {
  return target.modes.includes(mode);
}

export function getTargetVariants(target: ComparisonTarget): readonly FixtureVariantOption[] {
  return target.variants ?? [];
}

export function getVariant(target: ComparisonTarget, variantId: unknown): FixtureVariantOption | undefined {
  const variants = getTargetVariants(target);
  if (variants.length === 0) return undefined;
  if (variantId === undefined || variantId === null) {
    return variants.find((variant) => variant.id === target.defaultVariantId) ?? variants[0];
  }
  if (typeof variantId !== "string") return undefined;
  return variants.find((variant) => variant.id === variantId);
}

/** The route a run captures for the current side, given the selected variant. */
export function resolveCurrentRoute(target: ComparisonTarget, variantId: unknown): string {
  const variants = getTargetVariants(target);
  if (variants.length === 0) {
    if (variantId !== undefined && variantId !== null) {
      throw new RangeError(`Target ${target.id} does not offer page states`);
    }
    return target.current.path;
  }
  const variant = getVariant(target, variantId);
  if (!variant) {
    throw new RangeError(`Unknown page state for ${target.id}: ${String(variantId)}`);
  }
  return variant.route;
}
