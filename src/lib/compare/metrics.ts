import type { ComparisonStatus } from "./types";

/** Perceptual colour distance handed to pixelmatch ("smaller is more sensitive"). */
export const DEFAULT_PIXEL_THRESHOLD = 0.1;

/** Percentage of changed pixels tolerated before a run is a regression. */
export const DEFAULT_MAX_DIFF_PERCENT = 0.1;

export const MAX_ALLOWED_DIFF_PERCENT = 100;

/** Hard ceiling on rows kept in the run history payload. */
export const MAX_HISTORY = 25;

/**
 * Share of compared pixels that differ, as a percentage.
 * Guards against divide-by-zero and out-of-range inputs so a broken capture can
 * never produce a nonsense metric.
 */
export function computeChangePercentage(changedPixels: number, comparedPixels: number): number {
  if (!Number.isFinite(changedPixels) || !Number.isFinite(comparedPixels) || comparedPixels <= 0) {
    return 0;
  }
  const boundedChanged = Math.min(Math.max(changedPixels, 0), comparedPixels);
  return (boundedChanged / comparedPixels) * 100;
}

export function computeVerdict(changePercentage: number, maxDiffPercent: number): ComparisonStatus {
  return changePercentage > maxDiffPercent ? "regression" : "pass";
}

export function formatChangePercentage(value: number, maxFractionDigits = 3): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

export function formatChangePercentageLabel(value: number, maxFractionDigits = 3): string {
  return `${formatChangePercentage(value, maxFractionDigits)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Validates the tolerance coming from the client. Throws a RangeError for
 * anything that is not a finite percentage in range so the API can answer 400
 * instead of silently clamping.
 */
export function parseMaxDiffPercent(input: unknown): number {
  if (input === undefined || input === null) return DEFAULT_MAX_DIFF_PERCENT;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new RangeError("maxDiffPercent must be a finite number");
  }
  if (input < 0 || input > MAX_ALLOWED_DIFF_PERCENT) {
    throw new RangeError(`maxDiffPercent must be between 0 and ${MAX_ALLOWED_DIFF_PERCENT}`);
  }
  return roundTo(input, 4);
}
