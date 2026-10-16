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

export interface RunArtifacts {
  readonly baselinePng: Buffer;
  readonly currentPng: Buffer;
  readonly diffPng: Buffer;
}

export function artifactUrl(reportId: string, fileName: string): string {
  return `${ARTIFACT_URL_SEGMENT}/${reportId}/${fileName}`;
}

export async function persistRun(report: ComparisonReport, artifacts: RunArtifacts): Promise<void> {
  const directory = resolveReportDir(report.id);
  try {
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, ARTIFACT_FILENAMES.baseline), artifacts.baselinePng),
      writeFile(path.join(directory, ARTIFACT_FILENAMES.current), artifacts.currentPng),
      writeFile(path.join(directory, ARTIFACT_FILENAMES.diff), artifacts.diffPng),
      writeFile(path.join(directory, REPORT_FILENAME), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    ]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ComparisonError("storage_failed", `Could not persist the run: ${message}`, { cause });
  }
}

function toSummary(report: ComparisonReport): ReportSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    status: report.status,
    targetId: report.target.id,
    targetLabel: report.target.label,
    viewportId: report.viewport.id,
    viewportLabel: report.viewport.label,
    // Reports written before Phase 2 have no mode; they were all fixture comparisons.
    mode: report.mode === "baseline" ? "baseline" : "fixture",
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
