import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";
import {
  AUDIT_REPORT_FILENAME,
  isAuditFileName,
  isValidAuditId,
  resolveAuditDir,
  resolveAuditReportPath,
  resolveAuditScreenshotPath,
  resolveAuditsDir,
} from "@/lib/compare/storage-paths";
import type { AuditSummary, QualityReport } from "./types";

/**
 * Filesystem persistence for accessibility audits, one directory per audit:
 *
 *   <data>/audits/<auditId>/audit.json      the structured report (the evidence)
 *   <data>/audits/<auditId>/<viewport>.png   the screenshot each measurement came from
 *
 * The directory is separate from `reports/` on purpose — an audit is not a comparison,
 * holds no baseline and must never be mistaken for an approval. The JSON next to the PNGs
 * is the evidence a reviewer checks the findings against: rule, selector, markup and the
 * runner's own remediation text, all recorded at the moment of the scan.
 */

export const AUDIT_URL_SEGMENT = "/api/audits";

const MAX_SCANNED_AUDITS = 200;

/** Upper bound for one history page — the same clamp the reports endpoint applies. */
export const MAX_AUDIT_HISTORY = 50;

export function auditScreenshotUrl(auditId: string, viewportId: string): string {
  return `${AUDIT_URL_SEGMENT}/${encodeURIComponent(auditId)}/${encodeURIComponent(`${viewportId}.png`)}`;
}

export async function persistAudit(report: QualityReport, screenshots: Readonly<Record<string, Buffer>>): Promise<void> {
  const directory = resolveAuditDir(report.id);
  const files: Array<[string, Buffer | string, BufferEncoding | undefined]> = [
    [AUDIT_REPORT_FILENAME, `${JSON.stringify(report, null, 2)}\n`, "utf8"],
  ];
  for (const [viewportId, png] of Object.entries(screenshots)) {
    files.push([`${viewportId}.png`, png, undefined]);
  }

  try {
    await mkdir(directory, { recursive: true });
    await Promise.all(files.map(([name, data, encoding]) => writeFile(path.join(directory, name), data, encoding)));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ComparisonError("storage_failed", `Could not persist the audit: ${message}`, { cause });
  }
}

/** The stored report of one audit, or `null` when the id is not a stored audit. */
export async function readAudit(auditId: unknown): Promise<QualityReport | null> {
  if (!isValidAuditId(auditId)) {
    throw new ComparisonError("invalid_report_id", `Invalid audit id: ${String(auditId)}`);
  }
  try {
    const raw = await readFile(resolveAuditReportPath(auditId), "utf8");
    return JSON.parse(raw) as QualityReport;
  } catch {
    return null;
  }
}

/** One screenshot of a stored audit, guarded against traversal like run artifacts. */
export async function readAuditScreenshot(auditId: unknown, file: unknown): Promise<Buffer> {
  if (!isValidAuditId(auditId) || !isAuditFileName(file)) {
    throw new ComparisonError("invalid_report_id", "Unknown audit artifact requested");
  }
  try {
    if (file === AUDIT_REPORT_FILENAME) {
      return await readFile(resolveAuditReportPath(auditId));
    }
    return await readFile(resolveAuditScreenshotPath(auditId, file.slice(0, -".png".length)));
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ComparisonError("invalid_report_id", cause.message, { cause });
    }
    throw new ComparisonError("report_not_found", "That audit artifact is no longer on disk", { cause });
  }
}

function toSummary(report: QualityReport): AuditSummary {
  const counts = { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 };
  let totalFindings = 0;
  let needsReview = 0;
  let responsiveFindings = 0;
  for (const viewport of report.viewports) {
    for (const [impact, count] of Object.entries(viewport.accessibility.counts)) {
      counts[impact as keyof typeof counts] += count;
    }
    totalFindings += viewport.accessibility.totalFindings;
    needsReview += viewport.accessibility.needsReview;
    responsiveFindings += viewport.responsive.findings.length;
  }
  return {
    id: report.id,
    createdAt: report.createdAt,
    status: report.verdict.status,
    scopeKey: report.source.scopeKey,
    label: report.source.label,
    viewportIds: report.viewports.map((viewport) => viewport.viewport.id),
    counts,
    totalFindings,
    needsReview,
    responsiveFindings,
    newFindings: report.newFindingFingerprints.length,
  };
}

async function readAuditFile(auditId: string): Promise<QualityReport | null> {
  try {
    const raw = await readFile(path.join(resolveAuditDir(auditId), AUDIT_REPORT_FILENAME), "utf8");
    return JSON.parse(raw) as QualityReport;
  } catch {
    return null;
  }
}

/** Newest-first audit history, skipping anything that is not a stored audit. */
export async function listAuditSummaries(limit: number): Promise<AuditSummary[]> {
  let entries: string[];
  try {
    const dirents = await readdir(resolveAuditsDir(), { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isDirectory() && isValidAuditId(entry.name))
      .map((entry) => entry.name)
      .slice(0, MAX_SCANNED_AUDITS);
  } catch {
    return [];
  }

  const reports = await Promise.all(entries.map((entry) => readAuditFile(entry)));
  return reports
    .filter((report): report is QualityReport => report !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map(toSummary);
}
