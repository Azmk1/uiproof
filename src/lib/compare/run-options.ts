import { ComparisonError } from "./errors";
import { getTarget, resolveCurrentRoute, targetSupportsMode } from "./targets";
import type { ComparisonMode, ComparisonTarget } from "./types";

/**
 * Parsing and validation for the options a caller may send with a run.
 *
 * The body arrives as `unknown` from JSON, so nothing here trusts its shape: a
 * bad mode or variant becomes a typed 400 instead of a silent fallback, and the
 * target's own declarations decide what is allowed.
 */

export const DEFAULT_MODE: ComparisonMode = "fixture";
export const COMPARISON_MODES: readonly ComparisonMode[] = ["fixture", "baseline"];

export function isComparisonMode(value: unknown): value is ComparisonMode {
  return typeof value === "string" && (COMPARISON_MODES as readonly string[]).includes(value);
}

/** Absent means `fixture`, which keeps Phase 1 callers working unchanged. */
export function parseComparisonMode(input: unknown): ComparisonMode {
  if (input === undefined || input === null) return DEFAULT_MODE;
  if (!isComparisonMode(input)) {
    throw new RangeError(`mode must be one of: ${COMPARISON_MODES.join(", ")}`);
  }
  return input;
}

/** Absent means "the target's default page state". */
export function parseVariantId(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || input.length === 0 || input.length > 40) {
    throw new RangeError("variantId must be a short string");
  }
  return input;
}

/**
 * Resolves the target/mode/variant triple for a run. Every rejection here comes
 * back as a 400 that names the problem, so the console can show it verbatim.
 */
export function resolveRunTarget(options: {
  target: ComparisonTarget;
  mode: unknown;
  variantId: unknown;
}): { mode: ComparisonMode; variantId: string | null; currentRoute: string } {
  let mode: ComparisonMode;
  let variantId: string | null;
  try {
    mode = parseComparisonMode(options.mode);
    variantId = parseVariantId(options.variantId);
  } catch (cause) {
    throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
  }

  if (!targetSupportsMode(options.target, mode)) {
    throw new ComparisonError(
      "mode_unavailable",
      `${options.target.label} does not support ${mode} comparison. Available: ${options.target.modes.join(", ")}.`,
    );
  }

  let currentRoute: string;
  try {
    currentRoute = resolveCurrentRoute(options.target, variantId);
  } catch (cause) {
    throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
  }

  const variants = options.target.variants ?? [];
  const resolvedVariantId = variants.length === 0 ? null : (variantId ?? options.target.defaultVariantId ?? null);
  return { mode, variantId: resolvedVariantId, currentRoute };
}

export function requireTarget(id: unknown): ComparisonTarget {
  if (typeof id !== "string") {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${String(id)}`);
  }
  const target = getTarget(id);
  if (!target) {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${id}`);
  }
  return target;
}
