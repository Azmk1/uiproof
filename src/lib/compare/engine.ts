import { randomUUID } from "node:crypto";
import { readActiveBaseline, toBaselineReference } from "./baselines";
import { capturePage } from "./capture";
import { compareImages } from "./diff";
import { ComparisonError } from "./errors";
import { computeChangePercentage, computeVerdict, parseMaxDiffPercent, DEFAULT_PIXEL_THRESHOLD } from "./metrics";
import { resolveRunTarget, requireTarget } from "./run-options";
import { ARTIFACT_FILENAMES, type ArtifactName } from "./storage-paths";
import { artifactUrl, persistRun } from "./storage";
import { DEFAULT_VIEWPORT_ID, buildCaptureUrl, getViewport } from "./targets";
import type { ArtifactInfo, BaselineReference, ComparisonReport, ComparisonTarget, ViewportPreset } from "./types";

/**
 * The visual regression pipeline.
 *
 *   fixture  mode: capture the paired fixture route  → capture the page under test
 *   baseline mode: load the approved baseline image  → capture the page under test
 *   then: pixelmatch diff → verdict → persist artifacts + report
 *
 * Both modes share the comparison, the metrics and the storage layers, so a drift run
 * and a fixture run produce the same shape of report. The difference is where the
 * reference image came from, and the report records that explicitly (`mode`, `baseline`).
 */

export interface RunComparisonOptions {
  readonly targetId: unknown;
  readonly viewportId?: unknown;
  readonly maxDiffPercent?: unknown;
  /** `fixture` (default) or `baseline`. */
  readonly mode?: unknown;
  /** Page state to capture; only meaningful for targets that declare variants. */
  readonly variantId?: unknown;
  /** Origin of the running UIProof instance, used to reach the local fixtures. */
  readonly origin: string;
}

interface ReferenceSide {
  readonly referencePng: Buffer;
  readonly currentPng: Buffer;
  /** Route of the reference side, recorded for the report's `baselinePath`. */
  readonly baselinePath: string;
  readonly baselineReference: BaselineReference | null;
  readonly captureMs: number;
  readonly browser: string;
}

export function createReportId(): string {
  return `run-${randomUUID()}`;
}

/** Phase 1 behaviour: render both fixture routes at one viewport and diff them. */
async function referenceFromFixturePair(input: {
  readonly target: ComparisonTarget;
  readonly viewport: ViewportPreset;
  readonly origin: string;
  readonly currentRoute: string;
}): Promise<ReferenceSide> {
  let baselineUrl: URL;
  let currentUrl: URL;
  try {
    baselineUrl = buildCaptureUrl(input.origin, input.target.baseline.path);
    currentUrl = buildCaptureUrl(input.origin, input.currentRoute);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }

  const [baseline, current] = await Promise.all([
    capturePage({ url: baselineUrl, viewport: input.viewport }),
    capturePage({ url: currentUrl, viewport: input.viewport }),
  ]);

  return {
    referencePng: baseline.png,
    currentPng: current.png,
    baselinePath: input.target.baseline.path,
    baselineReference: null,
    captureMs: Math.max(baseline.durationMs, current.durationMs),
    browser: current.browser,
  };
}

/**
 * Drift detection: the reference image is the approved baseline stored on disk, and
 * only the page under test is captured. A missing baseline is a typed 404 rather than
 * a silent fallback to the fixture pair — approving is always an explicit act.
 */
async function referenceFromApprovedBaseline(input: {
  readonly target: ComparisonTarget;
  readonly viewport: ViewportPreset;
  readonly origin: string;
  readonly currentRoute: string;
}): Promise<ReferenceSide> {
  const approved = await readActiveBaseline(input.target.id, input.viewport.id);
  if (!approved) {
    throw new ComparisonError(
      "baseline_not_found",
      `No approved baseline for ${input.target.label} at ${input.viewport.label} yet. Approve a run as the baseline, then run again to detect drift.`,
    );
  }

  let currentUrl: URL;
  try {
    currentUrl = buildCaptureUrl(input.origin, input.currentRoute);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }
  const current = await capturePage({ url: currentUrl, viewport: input.viewport });

  return {
    referencePng: approved.png,
    currentPng: current.png,
    baselinePath: approved.version.capturedRoute,
    baselineReference: toBaselineReference(approved.version),
    captureMs: current.durationMs,
    browser: current.browser,
  };
}

export async function runComparison(options: RunComparisonOptions): Promise<ComparisonReport> {
  const totalStartedAt = Date.now();

  const target = requireTarget(options.targetId);

  const viewport = getViewport(options.viewportId ?? DEFAULT_VIEWPORT_ID);
  if (!viewport) {
    throw new ComparisonError("invalid_viewport", `Unknown viewport preset: ${String(options.viewportId)}`);
  }

  let maxDiffPercent: number;
  try {
    maxDiffPercent = parseMaxDiffPercent(options.maxDiffPercent);
  } catch (cause) {
    throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
  }

  const { mode, variantId, currentRoute } = resolveRunTarget({
    target,
    mode: options.mode,
    variantId: options.variantId,
  });

  const shared = { target, viewport, origin: options.origin, currentRoute };
  const reference =
    mode === "baseline"
      ? await referenceFromApprovedBaseline(shared)
      : await referenceFromFixturePair(shared);

  const compareStartedAt = Date.now();
  const comparison = compareImages(reference.referencePng, reference.currentPng, {
    pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
  });
  const compareMs = Date.now() - compareStartedAt;

  const changePercentage = computeChangePercentage(comparison.changedPixels, comparison.comparedPixels);
  const status = computeVerdict(changePercentage, maxDiffPercent);
  const reportId = createReportId();

  const artifact = (name: ArtifactName, png: Buffer, width: number, height: number): ArtifactInfo => ({
    url: artifactUrl(reportId, ARTIFACT_FILENAMES[name]),
    bytes: png.byteLength,
    width,
    height,
  });

  const report: ComparisonReport = {
    id: reportId,
    createdAt: new Date().toISOString(),
    status,
    mode,
    variantId,
    baseline: reference.baselineReference,
    target: {
      id: target.id,
      label: target.label,
      baselinePath: reference.baselinePath,
      currentPath: currentRoute,
    },
    viewport,
    metrics: {
      changedPixels: comparison.changedPixels,
      comparedPixels: comparison.comparedPixels,
      changePercentage,
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
      maxDiffPercent,
      dimensionsChanged: comparison.dimensionsChanged,
    },
    artifacts: {
      baseline: artifact(
        "baseline",
        reference.referencePng,
        comparison.baselineSize.width,
        comparison.baselineSize.height,
      ),
      current: artifact("current", reference.currentPng, comparison.currentSize.width, comparison.currentSize.height),
      diff: artifact("diff", comparison.diffPng, comparison.width, comparison.height),
    },
    engine: {
      provider: "playwright",
      comparator: "pixelmatch",
      browser: reference.browser,
      captureMs: reference.captureMs,
      compareMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };

  await persistRun(report, {
    baselinePng: reference.referencePng,
    currentPng: reference.currentPng,
    diffPng: comparison.diffPng,
  });

  return report;
}
