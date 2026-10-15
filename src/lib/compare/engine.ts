import { randomUUID } from "node:crypto";
import { capturePage } from "./capture";
import { compareImages } from "./diff";
import { ComparisonError } from "./errors";
import { computeChangePercentage, computeVerdict, parseMaxDiffPercent, DEFAULT_PIXEL_THRESHOLD } from "./metrics";
import { ARTIFACT_FILENAMES, type ArtifactName } from "./storage-paths";
import { artifactUrl, persistRun } from "./storage";
import { DEFAULT_VIEWPORT_ID, buildCaptureUrl, getTarget, getViewport } from "./targets";
import type { ArtifactInfo, ComparisonReport } from "./types";

/**
 * The visual regression pipeline:
 *   resolve target → capture baseline → capture current → pixelmatch diff
 *   → verdict → persist artifacts + report.
 *
 * The engine is the only piece that knows about all three layers; routes stay
 * thin and the maths stays pure.
 */

export interface RunComparisonOptions {
  readonly targetId: unknown;
  readonly viewportId?: unknown;
  readonly maxDiffPercent?: unknown;
  /** Origin of the running UIProof instance, used to reach the local fixtures. */
  readonly origin: string;
}

export function createReportId(): string {
  return `run-${randomUUID()}`;
}

export async function runComparison(options: RunComparisonOptions): Promise<ComparisonReport> {
  const totalStartedAt = Date.now();

  const target = getTarget(options.targetId);
  if (!target) {
    throw new ComparisonError(
      "invalid_target",
      `Unknown comparison target: ${String(options.targetId)}`,
    );
  }

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

  let baselineUrl: URL;
  let currentUrl: URL;
  try {
    baselineUrl = buildCaptureUrl(options.origin, target.baseline.path);
    currentUrl = buildCaptureUrl(options.origin, target.current.path);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }

  const [baseline, current] = await Promise.all([
    capturePage({ url: baselineUrl, viewport }),
    capturePage({ url: currentUrl, viewport }),
  ]);

  const compareStartedAt = Date.now();
  const comparison = compareImages(baseline.png, current.png, { pixelThreshold: DEFAULT_PIXEL_THRESHOLD });
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
    target: {
      id: target.id,
      label: target.label,
      baselinePath: target.baseline.path,
      currentPath: target.current.path,
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
      baseline: artifact("baseline", baseline.png, comparison.baselineSize.width, comparison.baselineSize.height),
      current: artifact("current", current.png, comparison.currentSize.width, comparison.currentSize.height),
      diff: artifact("diff", comparison.diffPng, comparison.width, comparison.height),
    },
    engine: {
      provider: "playwright",
      comparator: "pixelmatch",
      browser: baseline.browser,
      captureMs: Math.max(baseline.durationMs, current.durationMs),
      compareMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };

  await persistRun(report, {
    baselinePng: baseline.png,
    currentPng: current.png,
    diffPng: comparison.diffPng,
  });

  return report;
}
