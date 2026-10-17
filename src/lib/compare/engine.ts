import { randomUUID } from "node:crypto";
import { readActiveBaseline, toBaselineReference } from "./baselines";
import { capturePage } from "./capture";
import { compareImages } from "./diff";
import { ComparisonError } from "./errors";
import { computeChangePercentage, computeVerdict, parseMaxDiffPercent, DEFAULT_PIXEL_THRESHOLD } from "./metrics";
import { baselineScopeOf, resolveRun, type ResolvedRunSource } from "./run-options";
import { ARTIFACT_FILENAMES, type ArtifactName } from "./storage-paths";
import { artifactUrl, persistRun, type RunArtifacts } from "./storage";
import { DEFAULT_VIEWPORT_ID, buildCaptureUrl, getViewport } from "./targets";
import { buildProjectCaptureUrl } from "@/lib/projects/registry";
import { runQualitySection, type MeasuredPage } from "@/lib/quality/audit";
import { measureResponsive } from "@/lib/quality/responsive";
import { scanAccessibility } from "@/lib/quality/axe";
import type {
  ArtifactInfo,
  BaselineReference,
  ComparisonMode,
  ComparisonReport,
  ComparisonStatus,
  RegisteredProject,
  ReportArtifacts,
  RunSource,
  ViewportPreset,
} from "./types";

/**
 * The visual regression pipeline.
 *
 *   fixture  mode: capture the paired fixture route   → capture the page under test
 *   baseline mode: load the approved baseline image   → capture the page under test
 *   capture  mode: capture the page under test only   → nothing to compare against yet
 *   then: pixelmatch diff → verdict → persist artifacts + report
 *
 * All three modes share the capture, comparison, metrics and storage layers, so a
 * registered project and a demo fixture produce the same shape of report. For a project
 * the captured page is an application on its own origin; the capture is restricted to
 * the origins that application's registration allows, and the report records exactly
 * which project, route and origin it came from.
 */

export interface RunComparisonOptions {
  /** Phase 1/2 spelling of a demo target. Ignored when `source` is given. */
  readonly targetId?: unknown;
  /** Phase 3 spelling: a demo target or a registered project route. */
  readonly source?: unknown;
  readonly viewportId?: unknown;
  readonly maxDiffPercent?: unknown;
  /** `fixture` (default), `baseline` or `capture`. */
  readonly mode?: unknown;
  /** Page state to capture; only meaningful for targets that declare variants. */
  readonly variantId?: unknown;
  /** Origin of the running UIProof instance, used to reach the local fixtures. */
  readonly origin: string;
  /** Registered applications; pass the loaded configuration's projects. */
  readonly projects?: readonly RegisteredProject[];
  readonly projectConfigError?: string | null;
  /**
   * Phase 5: also measure the page under test for accessibility and responsive layout.
   * Accepts `true` (default policy) or a quality policy object. The visual verdict is
   * computed exactly as before and is never influenced by this.
   */
  readonly quality?: unknown;
}

interface ReferenceSide {
  readonly referencePng: Buffer | null;
  readonly currentPng: Buffer;
  /** Route of the reference side, recorded for the report's `baselinePath`. */
  readonly baselinePath: string;
  readonly baselineReference: BaselineReference | null;
  readonly captureMs: number;
  readonly browser: string;
  readonly blockedRequests: number;
  /** Quality measurements of the page under test, when the run asked for them. */
  readonly inspection: MeasuredPage | null;
}

/**
 * Measures the page under test when the run asked for quality checks. Runs inside the
 * capture, on the same page instance the screenshot came from, so a finding and a pixel
 * describe one rendering.
 */
function qualityInspector(
  quality: unknown,
  viewport: ViewportPreset,
): ((page: Parameters<NonNullable<Parameters<typeof capturePage>[0]["inspect"]>>[0]) => Promise<MeasuredPage>) | undefined {
  if (quality === undefined || quality === null || quality === false) return undefined;
  return async (page) => {
    const startedAt = Date.now();
    const accessibility = await scanAccessibility(page);
    const responsive = await measureResponsive(page, viewport);
    return { accessibility, responsive, scanMs: Date.now() - startedAt };
  };
}

export function createReportId(): string {
  return `run-${randomUUID()}`;
}

/** Phase 1 behaviour: render both fixture routes at one viewport and diff them. */
async function referenceFromFixturePair(input: {
  readonly source: ResolvedRunSource;
  readonly viewport: ViewportPreset;
  readonly currentRoute: string;
  readonly inspect?: (page: Parameters<NonNullable<Parameters<typeof capturePage>[0]["inspect"]>>[0]) => Promise<MeasuredPage>;
}): Promise<ReferenceSide> {
  const fixturePath = input.source.fixtureBaselinePath;
  if (!fixturePath) {
    throw new ComparisonError(
      "mode_unavailable",
      `${input.source.label} has no paired fixture route, so fixture comparison is not available for it.`,
    );
  }

  let baselineUrl: URL;
  let currentUrl: URL;
  try {
    baselineUrl = buildCaptureUrl(input.source.origin, fixturePath);
    currentUrl = buildCaptureUrl(input.source.origin, input.currentRoute);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }

  const [baseline, current] = await Promise.all([
    capturePage({ url: baselineUrl, viewport: input.viewport, label: input.source.label }),
    capturePage({
      url: currentUrl,
      viewport: input.viewport,
      label: input.source.label,
      inspect: input.inspect,
    }),
  ]);

  return {
    referencePng: baseline.png,
    currentPng: current.png,
    baselinePath: fixturePath,
    baselineReference: null,
    captureMs: Math.max(baseline.durationMs, current.durationMs),
    browser: current.browser,
    blockedRequests: baseline.blockedRequests + current.blockedRequests,
    inspection: current.inspection,
  };
}

/** The URL for the page under test, demo or registered project. */
function captureUrlFor(source: ResolvedRunSource, route: string): URL {
  try {
    if (source.kind === "project") {
      if (!source.project || !source.route) throw new RangeError("Project source is incomplete.");
      // Rebuilt from the registration, never from the request, so the approved origin
      // and path are the only ones that can be reached.
      return buildProjectCaptureUrl(source.project, source.route);
    }
    return buildCaptureUrl(source.origin, route);
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }
}

/**
 * Drift detection: the reference image is the approved baseline stored on disk, and only
 * the page under test is captured. A missing baseline is a typed 404 rather than a silent
 * fallback to the fixture pair — approving is always an explicit act.
 */
async function referenceFromApprovedBaseline(input: {
  readonly source: ResolvedRunSource;
  readonly viewport: ViewportPreset;
  readonly currentRoute: string;
  readonly inspect?: (page: Parameters<NonNullable<Parameters<typeof capturePage>[0]["inspect"]>>[0]) => Promise<MeasuredPage>;
}): Promise<ReferenceSide> {
  const approved = await readActiveBaseline(baselineScopeOf(input.source), input.viewport.id);
  if (!approved) {
    throw new ComparisonError(
      "baseline_not_found",
      `No approved baseline for ${input.source.label} at ${input.viewport.label} yet. Approve a run as the baseline, then run again to detect drift.`,
    );
  }

  const current = await capturePage({
    url: captureUrlFor(input.source, input.currentRoute),
    viewport: input.viewport,
    label: input.source.label,
    allowedOrigins: input.source.allowedOrigins,
    inspect: input.inspect,
  });

  return {
    referencePng: approved.png,
    currentPng: current.png,
    baselinePath: approved.version.capturedRoute,
    baselineReference: toBaselineReference(approved.version),
    captureMs: current.durationMs,
    browser: current.browser,
    blockedRequests: current.blockedRequests,
    inspection: current.inspection,
  };
}

/** The first screenshot of a route: nothing to compare against, so nothing is claimed. */
async function captureOnly(input: {
  readonly source: ResolvedRunSource;
  readonly viewport: ViewportPreset;
  readonly currentRoute: string;
  readonly inspect?: (page: Parameters<NonNullable<Parameters<typeof capturePage>[0]["inspect"]>>[0]) => Promise<MeasuredPage>;
}): Promise<ReferenceSide> {
  const current = await capturePage({
    url: captureUrlFor(input.source, input.currentRoute),
    viewport: input.viewport,
    label: input.source.label,
    allowedOrigins: input.source.allowedOrigins,
    inspect: input.inspect,
  });

  return {
    referencePng: null,
    currentPng: current.png,
    baselinePath: input.source.path,
    baselineReference: null,
    captureMs: current.durationMs,
    browser: current.browser,
    blockedRequests: current.blockedRequests,
    inspection: current.inspection,
  };
}

function toReportSource(source: ResolvedRunSource, blockedRequests: number): RunSource {
  return {
    kind: source.kind,
    scopeKey: source.scopeKey,
    label: source.label,
    projectId: source.project?.id ?? null,
    projectName: source.project?.name ?? null,
    routeId: source.route?.id ?? null,
    routeName: source.route?.name ?? null,
    origin: source.origin,
    path: source.path,
    blockedRequests,
  };
}

export async function runComparison(options: RunComparisonOptions): Promise<ComparisonReport> {
  const totalStartedAt = Date.now();

  const source = resolveRun({
    source: options.source,
    targetId: options.targetId,
    mode: options.mode,
    variantId: options.variantId,
    uiProofOrigin: options.origin,
    projects: options.projects ?? [],
    projectConfigError: options.projectConfigError ?? null,
  });

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

  const shared = {
    source: source.source,
    viewport,
    currentRoute: source.currentRoute,
    inspect: qualityInspector(options.quality, viewport),
  };
  const reference =
    source.mode === "baseline"
      ? await referenceFromApprovedBaseline(shared)
      : source.mode === "capture"
        ? await captureOnly(shared)
        : await referenceFromFixturePair(shared);

  const reportId = createReportId();
  const artifact = (name: ArtifactName, png: Buffer, width: number, height: number): ArtifactInfo => ({
    url: artifactUrl(reportId, ARTIFACT_FILENAMES[name]),
    bytes: png.byteLength,
    width,
    height,
  });

  let status: ComparisonStatus;
  let metrics: ComparisonReport["metrics"];
  let artifacts: ReportArtifacts;
  let compareMs = 0;
  let persisted: RunArtifacts = { currentPng: reference.currentPng };

  if (reference.referencePng === null) {
    status = "captured";
    metrics = {
      changedPixels: 0,
      comparedPixels: 0,
      changePercentage: 0,
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
      maxDiffPercent,
      dimensionsChanged: false,
    };
    // A capture has only the screenshot: there is no baseline and no difference image.
    artifacts = {
      current: artifact("current", reference.currentPng, viewport.width, viewport.height),
    };
  } else {
    const compareStartedAt = Date.now();
    const comparison = compareImages(reference.referencePng, reference.currentPng, {
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
    });
    compareMs = Date.now() - compareStartedAt;

    const changePercentage = computeChangePercentage(comparison.changedPixels, comparison.comparedPixels);
    status = computeVerdict(changePercentage, maxDiffPercent);
    metrics = {
      changedPixels: comparison.changedPixels,
      comparedPixels: comparison.comparedPixels,
      changePercentage,
      pixelThreshold: DEFAULT_PIXEL_THRESHOLD,
      maxDiffPercent,
      dimensionsChanged: comparison.dimensionsChanged,
    };
    artifacts = {
      baseline: artifact(
        "baseline",
        reference.referencePng,
        comparison.baselineSize.width,
        comparison.baselineSize.height,
      ),
      current: artifact("current", reference.currentPng, comparison.currentSize.width, comparison.currentSize.height),
      diff: artifact("diff", comparison.diffPng, comparison.width, comparison.height),
    };
    persisted = {
      currentPng: reference.currentPng,
      baselinePng: reference.referencePng,
      diffPng: comparison.diffPng,
    };
  }

  // Phase 5: the quality section is measured on the captured page and attached beside
  // the visual metrics. Absent when the run did not ask for it, so every older report and
  // every plain visual run is unchanged.
  const quality = reference.inspection
    ? await runQualitySection({
        resolved: source,
        viewport,
        accessibility: reference.inspection.accessibility,
        responsive: reference.inspection.responsive,
        policy: options.quality === true ? undefined : options.quality,
      })
    : undefined;

  const report: ComparisonReport = {
    id: reportId,
    createdAt: new Date().toISOString(),
    status,
    mode: source.mode as ComparisonMode,
    variantId: source.variantId,
    baseline: reference.baselineReference,
    quality,
    source: toReportSource(source.source, reference.blockedRequests),
    target: {
      // Demo targets keep their catalogue id so Phase 1/2 reports and readers stay
      // compatible; a project route is identified by its scope key.
      id: source.source.target?.id ?? source.source.scopeKey,
      label: source.source.label,
      baselinePath: reference.baselinePath,
      currentPath: source.currentRoute,
    },
    viewport,
    metrics,
    artifacts,
    engine: {
      provider: "playwright",
      comparator: "pixelmatch",
      browser: reference.browser,
      captureMs: reference.captureMs,
      compareMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };

  await persistRun(report, persisted);

  return report;
}
