import { readActiveBaseline } from "@/lib/compare/baselines";
import { compareImages } from "@/lib/compare/diff";
import { ComparisonError } from "@/lib/compare/errors";
import type { ProjectRoute, RegisteredProject, ViewportPreset } from "@/lib/compare/types";
import { runQualityAudit } from "@/lib/quality/audit";
import type { AccessibilitySummary, ResponsiveSummary } from "@/lib/quality/types";
import type {
  RepairAccessibilityMeasure,
  RepairLayoutMeasure,
  RepairMeasurement,
  RepairPageMeasurement,
  RepairVisualMeasure,
} from "./types";

/**
 * The measurement pass the repair engine runs before and after every patch.
 *
 * It is deliberately the *same* code path as `uiproof audit`: a real Chromium capture, the
 * real axe-core scan and the real responsive measurement, one page per route and viewport.
 * Nothing here re-implements a check, and nothing here reads a model's opinion. The only
 * additions are:
 *
 *  · **No persistence.** Sandbox audits are not written into the audit store, so a repair
 *    attempt can never be mistaken for a measurement someone asked for. The PNGs go into
 *    the repair's own evidence directory.
 *  · **A visual comparison against the approved baseline**, read-only. This is what lets a
 *    visual regression be repaired and re-measured without approving anything: the same
 *    active baseline the failing report used is diffed again, and the result is recorded.
 *
 * A measurement that could not run throws. There is no partially-measured page presented as
 * if it were clean.
 */

export interface MeasureRoute {
  readonly route: ProjectRoute;
  readonly viewports: readonly ViewportPreset[];
  /** Difference tolerance for the visual half, in percent of the viewport. */
  readonly tolerance: number;
}

export interface MeasurementImage {
  readonly name: string;
  readonly kind: "screenshot" | "diff";
  readonly phase: "before" | "after";
  readonly routeId: string;
  readonly viewportId: string;
  readonly buffer: Buffer;
}

export interface MeasurementResult {
  readonly measurement: RepairMeasurement;
  readonly images: readonly MeasurementImage[];
}

export interface MeasureSandboxOptions {
  readonly project: RegisteredProject;
  /** The sandbox origin; the routes come from the registered project. */
  readonly sandboxUrl: string;
  readonly routes: readonly MeasureRoute[];
  readonly phase: "before" | "after";
  /** Prefix for artifact names, so a second attempt cannot overwrite the first's evidence. */
  readonly namePrefix?: string;
  /** UIProof's own origin, required by the audit engine for demo sources only. */
  readonly uiProofOrigin: string;
  readonly policy?: unknown;
  readonly pixelThreshold?: number;
  /** Injected in tests; defaults to the real clock. */
  readonly now?: () => string;
}

function accessibilityOf(summary: AccessibilitySummary): RepairAccessibilityMeasure {
  const impactByFingerprint: Record<string, RepairAccessibilityMeasure["impactByFingerprint"][string]> = {};
  for (const violation of summary.violations) {
    if (!(violation.fingerprint in impactByFingerprint)) {
      impactByFingerprint[violation.fingerprint] = violation.impact ?? "unknown";
    }
  }
  return {
    violations: summary.violations.length,
    serious: summary.counts.serious,
    critical: summary.counts.critical,
    fingerprints: Object.keys(impactByFingerprint).sort(),
    impactByFingerprint,
    byImpact: { ...summary.counts },
  };
}

function layoutOf(summary: ResponsiveSummary): RepairLayoutMeasure {
  return {
    documentOverflowPx: summary.documentOverflowPx,
    defects: summary.defects.map((defect) => ({ selector: defect.selector, overflowPx: defect.overflowPx })),
    scrollableRegions: [...summary.scrollableRegions],
  };
}

const NO_VISUAL: RepairVisualMeasure = {
  baselineVersionId: "",
  changedPixels: 0,
  changePercentage: 0,
  tolerance: 0,
  dimensionsChanged: false,
  status: "no-baseline",
  detail: "No approved baseline exists for this route and viewport, so there is nothing to compare visually.",
};

async function visualOf(input: {
  readonly project: RegisteredProject;
  readonly route: ProjectRoute;
  readonly viewport: ViewportPreset;
  readonly png: Buffer;
  readonly tolerance: number;
  readonly pixelThreshold: number;
}): Promise<{ visual: RepairVisualMeasure; diff: Buffer | null }> {
  let baseline;
  try {
    baseline = await readActiveBaseline(
      { kind: "project", projectId: input.project.id, routeId: input.route.id },
      input.viewport.id,
    );
  } catch (cause) {
    return {
      diff: null,
      visual: {
        ...NO_VISUAL,
        tolerance: input.tolerance,
        status: "unreadable",
        detail: `The approved baseline could not be read: ${(cause as Error).message}`,
      },
    };
  }
  if (!baseline) {
    return { diff: null, visual: { ...NO_VISUAL, tolerance: input.tolerance } };
  }

  try {
    const compared = compareImages(baseline.png, input.png, { pixelThreshold: input.pixelThreshold });
    const regressed = compared.dimensionsChanged || compared.changePercentage > input.tolerance;
    return {
      diff: compared.diffPng,
      visual: {
        baselineVersionId: baseline.version.id,
        changedPixels: compared.changedPixels,
        changePercentage: Number(compared.changePercentage.toFixed(4)),
        tolerance: input.tolerance,
        dimensionsChanged: compared.dimensionsChanged,
        status: regressed ? "regressed" : "match",
        detail: regressed
          ? `${compared.changedPixels.toLocaleString("en-US")} pixel(s) differ from ${baseline.version.id}, ` +
            `${compared.changePercentage.toFixed(4)}% of the viewport against a ${input.tolerance}% tolerance` +
            `${compared.dimensionsChanged ? " (the dimensions changed)" : ""}.`
          : `Matches ${baseline.version.id} within the ${input.tolerance}% tolerance (${compared.changedPixels} changed pixel(s)).`,
      },
    };
  } catch (cause) {
    return {
      diff: null,
      visual: {
        ...NO_VISUAL,
        baselineVersionId: baseline.version.id,
        tolerance: input.tolerance,
        status: "unreadable",
        detail: `The screenshots could not be compared: ${(cause as Error).message}`,
      },
    };
  }
}

/**
 * Measures every route/viewport in the sandbox. Throws `repair_measurement_failed` when a
 * capture or scan did not run — an unmeasured candidate is never described as repaired.
 */
export async function measureSandbox(options: MeasureSandboxOptions): Promise<MeasurementResult> {
  const startedAt = options.now?.() ?? new Date().toISOString();
  const started = Date.now();
  const pages: RepairPageMeasurement[] = [];
  const images: MeasurementImage[] = [];
  const warnings: string[] = [];
  const pixelThreshold = options.pixelThreshold ?? 0.1;

  // The origin used for demo fixtures is never reached: these routes belong to a project,
  // and the audit engine builds their URLs from the sandboxed project's own origin.
  const sandboxedProject: RegisteredProject = {
    ...options.project,
    origin: options.sandboxUrl,
    routes: options.project.routes.map((route) => ({ ...route, url: `${options.sandboxUrl}${route.path}` })),
  };

  const prefix = options.namePrefix ?? "";

  for (const entry of options.routes) {
    if (entry.viewports.length === 0) {
      warnings.push(`Route ${entry.route.id} was not measured: no viewport was selected.`);
      continue;
    }

    let result;
    try {
      result = await runQualityAudit({
        source: { kind: "project", projectId: options.project.id, routeId: entry.route.id },
        viewports: entry.viewports.map((viewport) => viewport.id),
        policy: options.policy,
        origin: options.uiProofOrigin,
        projects: [sandboxedProject],
        projectConfigError: null,
        persist: false,
        returnScreenshots: true,
      });
    } catch (cause) {
      throw new ComparisonError(
        "repair_measurement_failed",
        `The sandbox could not be measured at ${entry.route.path}: ${(cause as Error).message}`,
        { cause },
      );
    }

    for (const viewportReport of result.report.viewports) {
      const viewport = viewportReport.viewport;
      const png = result.screenshotBuffers?.[viewport.id];
      if (!png) {
        throw new ComparisonError(
          "repair_measurement_failed",
          `The ${viewport.label} capture of ${entry.route.path} produced no screenshot, so it cannot be verified.`,
        );
      }

      const screenshotName = `${prefix}${options.phase}-${entry.route.id}-${viewport.id}.png`;
      images.push({
        name: screenshotName,
        kind: "screenshot",
        phase: options.phase,
        routeId: entry.route.id,
        viewportId: viewport.id,
        buffer: png,
      });

      const { visual, diff } = await visualOf({
        project: options.project,
        route: entry.route,
        viewport,
        png,
        tolerance: entry.tolerance,
        pixelThreshold,
      });
      let diffName: string | null = null;
      if (diff) {
        diffName = `${prefix}${options.phase}-${entry.route.id}-${viewport.id}-diff.png`;
        images.push({
          name: diffName,
          kind: "diff",
          phase: options.phase,
          routeId: entry.route.id,
          viewportId: viewport.id,
          buffer: diff,
        });
      }

      pages.push({
        routeId: entry.route.id,
        path: entry.route.path,
        viewportId: viewport.id,
        viewportLabel: viewport.label,
        accessibility: accessibilityOf(viewportReport.accessibility),
        layout: layoutOf(viewportReport.responsive),
        visual,
        screenshot: screenshotName,
        diff: diffName,
        measuredAt: options.now?.() ?? new Date().toISOString(),
      });
    }
  }

  if (pages.length === 0) {
    throw new ComparisonError(
      "repair_measurement_failed",
      "No route in the sandbox produced a measurement, so no repair could be verified.",
    );
  }

  return {
    measurement: {
      phase: options.phase,
      startedAt,
      totalMs: Date.now() - started,
      pages,
      warnings,
    },
    images,
  };
}
