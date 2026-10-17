import type { ViewportPreset } from "@/lib/compare/types";
import { IMPACT_ORDER } from "./types";
import type {
  AccessibilityFinding,
  AccessibilitySummary,
  AxeImpact,
  QualityPolicy,
  QualityReference,
  QualityReport,
  QualityScreenshot,
  QualitySection,
  QualityVerdict,
  ResponsiveSummary,
} from "./types";

/**
 * What the dashboard's quality panel renders, built from what the engine measured.
 *
 * Pure and React-free for the same reason `compare/source-selection.ts` is: the panel is
 * a view of a report, so the shaping of that view is unit tested here and the component
 * only lays it out. Nothing here invents a number — every count is derived from the
 * findings the runner produced, and "needs review" results stay separate from violations
 * because they are questions for a human, not failures.
 */

/** One audited viewport: both measurements plus the screenshot they came from. */
export interface QualityPanelEntry {
  readonly viewport: ViewportPreset;
  readonly accessibility: AccessibilitySummary;
  readonly responsive: ResponsiveSummary;
  /** `null` when the measurements were not persisted with a screenshot. */
  readonly screenshot: QualityScreenshot | null;
}

/** Engine facts shown next to the verdict, when the report recorded them. */
export interface QualityPanelEngine {
  readonly axeVersion: string;
  readonly ruleSets: readonly string[];
  readonly browser: string | null;
  readonly totalMs: number | null;
}

export interface QualityPanelModel {
  /** `null` for a section attached to a comparison run rather than a stored audit. */
  readonly id: string | null;
  readonly createdAt: string | null;
  readonly policy: QualityPolicy;
  readonly verdict: QualityVerdict;
  readonly entries: readonly QualityPanelEntry[];
  readonly references: readonly QualityReference[];
  readonly newFindingFingerprints: readonly string[];
  readonly knownFindingFingerprints: readonly string[];
  readonly resolvedFindingFingerprints: readonly string[];
  readonly engine: QualityPanelEngine | null;
}

/** One finding deduplicated across viewports, with the viewports it appeared at. */
export interface FindingRow {
  readonly fingerprint: string;
  readonly finding: AccessibilityFinding;
  readonly viewportIds: readonly string[];
}

export interface ImpactGroup {
  /** `unknown` collects findings whose impact the runner declined to state. */
  readonly impact: AxeImpact | "unknown";
  readonly rows: readonly FindingRow[];
}

export interface GroupedFindings {
  /** Violations, grouped by impact, most severe first. Empty groups are omitted. */
  readonly violations: readonly ImpactGroup[];
  /** Results the runner could not decide — reported, never counted as failures. */
  readonly review: readonly FindingRow[];
}

const IMPACT_GROUPS: readonly (AxeImpact | "unknown")[] = [...[...IMPACT_ORDER].reverse(), "unknown"];

function collectRows(entries: readonly QualityPanelEntry[]): FindingRow[] {
  const byFingerprint = new Map<string, { finding: AccessibilityFinding; viewportIds: string[] }>();
  for (const entry of entries) {
    for (const finding of entry.accessibility.findings) {
      const existing = byFingerprint.get(finding.fingerprint);
      if (existing) {
        if (!existing.viewportIds.includes(entry.viewport.id)) existing.viewportIds.push(entry.viewport.id);
      } else {
        byFingerprint.set(finding.fingerprint, { finding, viewportIds: [entry.viewport.id] });
      }
    }
  }
  return [...byFingerprint.values()].map(({ finding, viewportIds }) => ({
    fingerprint: finding.fingerprint,
    finding,
    viewportIds,
  }));
}

/**
 * Deduplicates findings across viewports by fingerprint and groups the violations by
 * impact, most severe first. Needs-review results are returned apart: a scan that could
 * not decide something is a question, and only violations can fail a policy.
 */
export function groupFindingsByImpact(entries: readonly QualityPanelEntry[]): GroupedFindings {
  const rows = collectRows(entries);
  const violations = rows.filter((row) => row.finding.status === "violation");
  const review = rows.filter((row) => row.finding.status !== "violation");

  const groups: ImpactGroup[] = [];
  for (const impact of IMPACT_GROUPS) {
    const matching = violations.filter((row) => (row.finding.impact ?? "unknown") === impact);
    if (matching.length > 0) groups.push({ impact, rows: matching });
  }
  return { violations: groups, review };
}

/** The panel model of a stored multi-viewport audit. */
export function qualityModelFromReport(report: QualityReport): QualityPanelModel {
  return {
    id: report.id,
    createdAt: report.createdAt,
    policy: report.policy,
    verdict: report.verdict,
    entries: report.viewports.map((entry) => ({
      viewport: entry.viewport,
      accessibility: entry.accessibility,
      responsive: entry.responsive,
      screenshot: entry.screenshot,
    })),
    references: report.references,
    newFindingFingerprints: report.newFindingFingerprints,
    knownFindingFingerprints: report.knownFindingFingerprints,
    resolvedFindingFingerprints: report.resolvedFindingFingerprints,
    engine: {
      axeVersion: report.engine.axeVersion,
      ruleSets: report.engine.ruleSets,
      browser: report.engine.browser,
      totalMs: report.engine.totalMs,
    },
  };
}

/**
 * The panel model of the quality section a comparison run carries. One viewport, no
 * stored audit id — the run's own capture is the evidence behind the measurements.
 */
export function qualityModelFromSection(
  section: QualitySection,
  viewport: ViewportPreset,
  screenshot: QualityScreenshot | null,
): QualityPanelModel {
  return {
    id: null,
    createdAt: null,
    policy: section.policy,
    verdict: section.verdict,
    entries: [
      {
        viewport,
        accessibility: section.accessibility,
        responsive: section.responsive,
        screenshot,
      },
    ],
    references: section.references,
    newFindingFingerprints: section.newFindingFingerprints,
    knownFindingFingerprints: section.knownFindingFingerprints,
    resolvedFindingFingerprints: section.resolvedFindingFingerprints,
    engine: {
      axeVersion: section.accessibility.runner.version,
      ruleSets: section.accessibility.runner.ruleSets,
      browser: null,
      totalMs: null,
    },
  };
}
