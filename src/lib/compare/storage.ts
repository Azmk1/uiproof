import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComparisonError } from "./errors";
import {
  ARTIFACT_FILENAMES,
  REPORT_FILENAME,
  isValidFileName,
  isValidReportId,
  resolveArtifactPath,
  resolveReportDir,
  resolveReportsDir,
} from "./storage-paths";
import type { ComparisonReport, ReportSummary } from "./types";

/**
 * Filesystem persistence for runs. Everything lives under the data directory
 * (default `<project>/.uiproof/data`) so a refresh — or a server restart —
 * still shows the previous results.
 *
 * The surface is deliberately small: swapping this module for object storage is
 * the intended path for hosted deployments.
 */

export const ARTIFACT_URL_SEGMENT = "/api/artifacts";

const MAX_SCANNED_RUNS = 200;

/** Only the artifacts a run actually produced are written and referenced. */
export interface RunArtifacts {
  readonly currentPng: Buffer;
  readonly baselinePng?: Buffer;
  readonly diffPng?: Buffer;
}

export function artifactUrl(reportId: string, fileName: string): string {
  return `${ARTIFACT_URL_SEGMENT}/${reportId}/${fileName}`;
}

export async function persistRun(report: ComparisonReport, artifacts: RunArtifacts): Promise<void> {
  const directory = resolveReportDir(report.id);
  // Build the list of files first and only start writing after the directory exists:
  // creating the write promises up front lets them race `mkdir` and fail with ENOENT on a
  // data directory that has never stored a run.
  const files: Array<[string, Buffer | string, BufferEncoding | undefined]> = [
    [ARTIFACT_FILENAMES.current, artifacts.currentPng, undefined],
    [REPORT_FILENAME, `${JSON.stringify(report, null, 2)}\n`, "utf8"],
  ];
  if (artifacts.baselinePng) files.push([ARTIFACT_FILENAMES.baseline, artifacts.baselinePng, undefined]);
  if (artifacts.diffPng) files.push([ARTIFACT_FILENAMES.diff, artifacts.diffPng, undefined]);

  try {
    await mkdir(directory, { recursive: true });
    await Promise.all(files.map(([name, data, encoding]) => writeFile(path.join(directory, name), data, encoding)));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ComparisonError("storage_failed", `Could not persist the run: ${message}`, { cause });
  }
}

/** The scope key of a report, derived from its source when it has one. */
export function scopeKeyOf(report: ComparisonReport): string {
  if (report.source?.scopeKey) return report.source.scopeKey;
  return `demo:${report.target.id}`;
}

/** The source kind of a report, defaulting to demo for pre-Phase-3 reports. */
export function sourceKindOf(report: ComparisonReport): "demo" | "project" {
  return report.source?.kind ?? "demo";
}

function toSummary(report: ComparisonReport): ReportSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    status: report.status,
    targetId: report.target.id,
    targetLabel: report.target.label,
    scopeKey: scopeKeyOf(report),
    kind: sourceKindOf(report),
    viewportId: report.viewport.id,
    viewportLabel: report.viewport.label,
    // Reports written before Phase 2 have no mode; they were all fixture comparisons.
    mode: report.mode ?? "fixture",
    variantId: report.variantId ?? null,
    changePercentage: report.metrics.changePercentage,
  };
}

async function readReportFile(reportId: string): Promise<ComparisonReport | null> {
  try {
    const raw = await readFile(path.join(resolveReportDir(reportId), REPORT_FILENAME), "utf8");
    return JSON.parse(raw) as ComparisonReport;
  } catch {
    return null;
  }
}

/** Newest-first run history, skipping any directory that is not a valid run. */
export async function listReportSummaries(limit: number): Promise<ReportSummary[]> {
  let entries: string[];
  try {
    const dirents = await readdir(resolveReportsDir(), { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isDirectory() && isValidReportId(entry.name))
      .map((entry) => entry.name)
      .slice(0, MAX_SCANNED_RUNS);
  } catch {
    return [];
  }

  const reports = await Promise.all(entries.map((entry) => readReportFile(entry)));
  return reports
    .filter((report): report is ComparisonReport => report !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map(toSummary);
}

export async function readReport(reportId: unknown): Promise<ComparisonReport | null> {
  if (!isValidReportId(reportId)) {
    throw new ComparisonError("invalid_report_id", `Invalid report id: ${String(reportId)}`);
  }
  return readReportFile(reportId);
}

export async function readArtifact(reportId: unknown, fileName: unknown): Promise<Buffer> {
  if (!isValidReportId(reportId) || !isValidFileName(fileName)) {
    throw new ComparisonError("invalid_report_id", "Unknown artifact requested");
  }
  try {
    return await readFile(resolveArtifactPath(reportId, fileName));
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ComparisonError("invalid_report_id", cause.message, { cause });
    }
    throw new ComparisonError("report_not_found", "That artifact is no longer on disk", { cause });
  }
}
