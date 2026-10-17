import { randomUUID } from "node:crypto";
import { findActiveVersion, readBaselineManifest } from "@/lib/compare/baselines";
import { capturePage } from "@/lib/compare/capture";
import { ComparisonError } from "@/lib/compare/errors";
import { baselineScopeOf, resolveRun, type ResolvedRun } from "@/lib/compare/run-options";
import { VIEWPORT_PRESETS, getViewport } from "@/lib/compare/targets";
import { buildProjectCaptureUrl } from "@/lib/projects/registry";
import { AXE_RULE_SETS, AXE_VERSION, scanAccessibility } from "./axe";
import { fingerprintViolations, snapshotOf } from "./fingerprint";
import { DEFAULT_QUALITY_POLICY, evaluateQualityPolicy, parseQualityPolicy } from "./policy";
import { measureResponsive } from "./responsive";
import { auditScreenshotUrl, persistAudit } from "./storage";
import type {
  QualityPolicy,
  QualityReference,
  QualityReport,
  QualitySection,
  QualityViewportReport,
  ResponsiveSummary,
  AccessibilitySummary,
} from "./types";
import type { RegisteredProject, ViewportPreset } from "@/lib/compare/types";

/**
 * The quality audit engine: one page, measured for accessibility and responsive layout,
 * at one or more viewport presets, judged by a deterministic policy.
 *
 * It is the single implementation behind `uiproof audit`, `POST /api/quality/audit` and
 * the `quality` section of a comparison report. There is no second scanner to drift out of
 * step with the first.
 *
 * Two properties the phase brief demands, enforced here rather than in a caller:
 *
 *  · **A scan that did not run never looks like a clean scan.** Every viewport's
 *    measurements come from the same page instance the screenshot was taken from; if the
 *    scanner cannot run, the whole audit fails with `quality_unavailable` and nothing is
 *    persisted. There is no code path that stores a report with invented findings.
 *  · **"New" means "new since an approved reference", or nothing.** The fingerprint sets a
 *    run is compared against come from the *approved baseline versions* of the same scope
 *    and viewport — the same trust anchor the visual gate uses — never from "the previous
 *    run", which nobody approved. With no approved reference the report says so and the
 *    policy counts every finding.
 *
 * Responsive and accessibility results are kept apart from visual metrics everywhere: this
 * module never computes pixel differences and never writes to the visual baseline store.
 */

export interface RunQualityAuditOptions {
  /** Phase 3 spelling of the source: `{ kind, projectId, routeId }`. */
  readonly source?: unknown;
  /** Phase 1/2 spelling of a demo target. */
  readonly targetId?: unknown;
  readonly variantId?: unknown;
  /** Viewport preset ids to audit. Absent means every preset (desktop, tablet, mobile). */
  readonly viewports?: unknown;
  /** Quality policy object; absent means the documented defaults. */
  readonly policy?: unknown;
  /** Origin of this UIProof instance, used to reach demo fixtures. */
  readonly origin: string;
  readonly projects?: readonly RegisteredProject[];
  readonly projectConfigError?: string | null;
  /** Persist the audit (report JSON + screenshots). False keeps nothing on disk. */
  readonly persist?: boolean;
}

export interface MeasuredPage {
  readonly accessibility: AccessibilitySummary;
  readonly responsive: ResponsiveSummary;
  readonly scanMs: number;
}

function parseViewports(input: unknown): ViewportPreset[] {
  if (input === undefined || input === null) return [...VIEWPORT_PRESETS];
  const requested = Array.isArray(input) ? input : [input];
  if (requested.length === 0 || requested.length > VIEWPORT_PRESETS.length) {
    throw new ComparisonError("invalid_viewport", "viewports must name one or more of: desktop, tablet, mobile");
  }
  const presets: ViewportPreset[] = [];
  for (const id of requested) {
    const preset = getViewport(id);
    if (!preset) {
      throw new ComparisonError("invalid_viewport", `Unknown viewport preset: ${String(id)}`);
    }
    if (!presets.includes(preset)) presets.push(preset);
  }
  return presets;
}

function captureUrlFor(resolved: ResolvedRun): URL {
  try {
    if (resolved.source.kind === "project") {
      if (!resolved.source.project || !resolved.source.route) throw new RangeError("Project source is incomplete.");
      return buildProjectCaptureUrl(resolved.source.project, resolved.source.route);
    }
    return new URL(resolved.currentRoute, resolved.source.origin);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }
}

/**
 * The approved accessibility references for this scope. One per viewport that has an
 * approved baseline carrying a snapshot; a viewport without one contributes nothing, and
 * the report lists exactly which versions were used.
 */
async function readReferences(resolved: ResolvedRun, viewports: readonly ViewportPreset[]): Promise<QualityReference[]> {
  let scope;
  try {
    scope = baselineScopeOf(resolved.source);
  } catch {
    return [];
  }

  const references: QualityReference[] = [];
  for (const viewport of viewports) {
    const manifest = await readBaselineManifest(scope, viewport.id).catch(() => null);
    const version = manifest ? findActiveVersion(manifest) : null;
    const snapshot = version?.quality;
    if (!snapshot || !version) continue;
    references.push({
      viewportId: viewport.id,
      versionId: version.id,
      approvedAt: snapshot.approvedAt,
      runnerVersion: snapshot.runnerVersion,
      fingerprints: snapshot.fingerprints,
      violationCount: snapshot.violationCount,
    });
  }
  return references;
}

/** Runs both measurements on the captured page, timed separately from the capture. */
async function measurePage(page: Parameters<NonNullable<Parameters<typeof capturePage>[0]["inspect"]>>[0], viewport: ViewportPreset): Promise<MeasuredPage> {
  const startedAt = Date.now();
  const accessibility = await scanAccessibility(page);
  const responsive = await measureResponsive(page, viewport);
  return { accessibility, responsive, scanMs: Date.now() - startedAt };
}

export interface QualityVerdictSummary {
  readonly policy: QualityPolicy;
  readonly newFindingFingerprints: readonly string[];
  readonly knownFindingFingerprints: readonly string[];
  readonly resolvedFindingFingerprints: readonly string[];
  readonly verdict: QualityReport["verdict"];
  readonly countedFingerprints: readonly string[];
}

/**
 * The judgement step, shared by audits and comparison reports. Pure over its inputs:
 * two runs with the same measurements, policy and references always fail in the same way.
 */
export function judgeMeasurements(input: {
  readonly policy: QualityPolicy;
  readonly viewports: readonly {
    readonly viewportId: string;
    readonly accessibility: AccessibilitySummary;
    readonly responsive: ResponsiveSummary;
  }[];
  readonly references: readonly QualityReference[];
}): QualityVerdictSummary {
  const referenceFingerprints = input.references.length === 0
    ? null
    : [...new Set(input.references.flatMap((reference) => reference.fingerprints))].sort();

  const evaluated = evaluateQualityPolicy({
    policy: input.policy,
    viewports: input.viewports,
    referenceFingerprints,
  });

  return {
    policy: input.policy,
    verdict: evaluated.verdict,
    newFindingFingerprints: evaluated.newFindingFingerprints,
    knownFindingFingerprints: evaluated.knownFindingFingerprints,
    resolvedFindingFingerprints: evaluated.resolvedFindingFingerprints,
    countedFingerprints: evaluated.countedFingerprints,
  };
}

/** The section a comparison report carries next to its visual metrics. */
export async function runQualitySection(input: {
  readonly resolved: ResolvedRun;
  readonly viewport: ViewportPreset;
  readonly accessibility: AccessibilitySummary;
  readonly responsive: ResponsiveSummary;
  readonly policy?: unknown;
}): Promise<QualitySection> {
  let policy: QualityPolicy;
  try {
    policy = parseQualityPolicy(input.policy);
  } catch (cause) {
    throw new ComparisonError("quality_policy_invalid", (cause as Error).message, { cause });
  }
  const references = await readReferences(input.resolved, [input.viewport]);
  const judged = judgeMeasurements({
    policy,
    viewports: [{ viewportId: input.viewport.id, accessibility: input.accessibility, responsive: input.responsive }],
    references,
  });

  return {
    policy,
    verdict: judged.verdict,
    accessibility: input.accessibility,
    responsive: input.responsive,
    references,
    newFindingFingerprints: judged.newFindingFingerprints,
    knownFindingFingerprints: judged.knownFindingFingerprints,
    resolvedFindingFingerprints: judged.resolvedFindingFingerprints,
  };
}

export interface RunQualityAuditResult {
  readonly report: QualityReport;
  /** Absolute path of the persisted `audit.json`, when the audit was persisted. */
  readonly reportPath: string | null;
  /** Absolute paths of the persisted screenshots, keyed by viewport id. */
  readonly screenshotPaths: Readonly<Record<string, string>>;
}

/**
 * Runs a full audit: capture → measure → judge → persist. The returned report is exactly
 * what lands on disk as `audit.json`, so a CI log and the stored evidence cannot disagree.
 */
export async function runQualityAudit(options: RunQualityAuditOptions): Promise<RunQualityAuditResult> {
  const startedAt = Date.now();

  const resolved = resolveRun({
    source: options.source,
    targetId: options.targetId,
    variantId: options.variantId,
    // An audit measures the page as it is now; it never needs a comparison mode.
    mode: "capture",
    uiProofOrigin: options.origin,
    projects: options.projects ?? [],
    projectConfigError: options.projectConfigError ?? null,
  });

  let policy: QualityPolicy;
  try {
    policy = options.policy === undefined ? DEFAULT_QUALITY_POLICY : parseQualityPolicy(options.policy);
  } catch (cause) {
    throw new ComparisonError("quality_policy_invalid", (cause as Error).message, { cause });
  }

  const viewports = parseViewports(options.viewports);
  const url = captureUrlFor(resolved);
  const references = await readReferences(resolved, viewports);

  const auditId = `audit-${randomUUID()}`;
  const screenshots: Record<string, Buffer> = {};
  const viewportReports: QualityViewportReport[] = [];
  let browser = "chromium";

  for (const viewport of viewports) {
    const capture = await capturePage<MeasuredPage>({
      url,
      viewport,
      label: `${resolved.source.label} at ${viewport.label}`,
      allowedOrigins: resolved.source.allowedOrigins,
      inspect: (page) => measurePage(page, viewport),
    });
    if (!capture.inspection) {
      throw new ComparisonError("quality_unavailable", "The page was captured but no measurements were taken.");
    }
    browser = capture.browser;
    screenshots[viewport.id] = capture.png;
    viewportReports.push({
      viewport,
      accessibility: capture.inspection.accessibility,
      responsive: capture.inspection.responsive,
      screenshot: {
        url: auditScreenshotUrl(auditId, viewport.id),
        bytes: capture.png.byteLength,
        width: viewport.width,
        height: viewport.height,
      },
      captureMs: capture.durationMs,
      scanMs: capture.inspection.scanMs,
    });
  }

  const judged = judgeMeasurements({
    policy,
    viewports: viewportReports.map((entry) => ({
      viewportId: entry.viewport.id,
      accessibility: entry.accessibility,
      responsive: entry.responsive,
    })),
    references,
  });

  const report: QualityReport = {
    id: auditId,
    createdAt: new Date().toISOString(),
    policy,
    verdict: judged.verdict,
    source: {
      kind: resolved.source.kind,
      scopeKey: resolved.source.scopeKey,
      label: resolved.source.label,
      projectId: resolved.source.project?.id ?? null,
      projectName: resolved.source.project?.name ?? null,
      routeId: resolved.source.route?.id ?? null,
      routeName: resolved.source.route?.name ?? null,
      origin: resolved.source.origin,
      path: resolved.currentRoute,
      blockedRequests: 0,
    },
    viewports: viewportReports,
    references,
    newFindingFingerprints: judged.newFindingFingerprints,
    knownFindingFingerprints: judged.knownFindingFingerprints,
    resolvedFindingFingerprints: judged.resolvedFindingFingerprints,
    engine: {
      axeVersion: AXE_VERSION,
      ruleSets: [...AXE_RULE_SETS],
      browser,
      totalMs: Date.now() - startedAt,
    },
  };

  if (options.persist === false) {
    return { report, reportPath: null, screenshotPaths: {} };
  }

  await persistAudit(report, screenshots);
  return {
    report,
    reportPath: `audits/${report.id}/audit.json`,
    screenshotPaths: Object.fromEntries(viewports.map((viewport) => [viewport.id, `audits/${report.id}/${viewport.id}.png`])),
  };
}

/** The fingerprint set an approval of this run would record — used by baseline approval. */
export function snapshotFromSection(section: QualitySection, approvedAt: string) {
  return snapshotOf(section.accessibility.findings, section.accessibility.runner.version, approvedAt);
}

export { fingerprintViolations };
