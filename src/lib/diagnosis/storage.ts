import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";
import {
  DIAGNOSIS_FILENAME,
  isValidDiagnosisId,
  resolveDiagnosesDir,
  resolveDiagnosisDir,
  resolveDiagnosisReportPath,
} from "@/lib/compare/storage-paths";
import type { Diagnosis, DiagnosisSummary } from "./types";

/**
 * Filesystem persistence for diagnoses:
 *
 *   <data>/diagnoses/<diagId>/diagnosis.json
 *
 * Deliberately a third directory beside `reports/` and `audits/`. A diagnosis is an
 * interpretation of a report, not a report: nothing in the verdict path can read it, and
 * deleting the whole directory would not change a single pass or fail.
 */

const MAX_SCANNED = 200;
export const MAX_DIAGNOSIS_HISTORY = 50;

export function diagnosisId(): string {
  return `diag-${crypto.randomUUID()}`;
}

export function summarizeDiagnosis(diagnosis: Diagnosis): DiagnosisSummary {
  const diagnosed = diagnosis.issues.filter((issue) => issue.diagnosis !== null);
  return {
    id: diagnosis.id,
    createdAt: diagnosis.createdAt,
    reportId: diagnosis.reportId,
    auditId: diagnosis.auditId,
    scopeKey: diagnosis.scopeKey,
    sourceLabel: diagnosis.sourceLabel,
    model: diagnosis.model.model,
    issues: diagnosis.issues.length,
    diagnosed: diagnosed.length,
    verifiedSources: diagnosed.reduce((total, issue) => total + (issue.diagnosis?.sources.length ?? 0), 0),
    unverifiedSources: diagnosed.reduce((total, issue) => total + (issue.diagnosis?.unverifiedSources.length ?? 0), 0),
  };
}

export async function persistDiagnosis(diagnosis: Diagnosis): Promise<string> {
  const file = resolveDiagnosisReportPath(diagnosis.id);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ComparisonError("storage_failed", `Could not persist the diagnosis: ${message}`, { cause });
  }
  return file;
}

/** The stored diagnosis, or `null` when the id is not a stored diagnosis. */
export async function readDiagnosis(diagnosisId: unknown): Promise<Diagnosis | null> {
  if (!isValidDiagnosisId(diagnosisId)) {
    throw new ComparisonError("invalid_report_id", `Invalid diagnosis id: ${String(diagnosisId)}`);
  }
  try {
    return JSON.parse(await readFile(resolveDiagnosisReportPath(diagnosisId), "utf8")) as Diagnosis;
  } catch {
    return null;
  }
}

/** Newest-first history, skipping anything that is not a usable diagnosis file. */
export async function listDiagnoses(limit: number, scopeKey?: string | null): Promise<DiagnosisSummary[]> {
  let entries: string[];
  try {
    const dirents = await readdir(resolveDiagnosesDir(), { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isDirectory() && isValidDiagnosisId(entry.name))
      .map((entry) => entry.name)
      .slice(0, MAX_SCANNED);
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map(async (entry) => {
      try {
        const raw = await readFile(path.join(resolveDiagnosisDir(entry), DIAGNOSIS_FILENAME), "utf8");
        return JSON.parse(raw) as Diagnosis;
      } catch {
        return null;
      }
    }),
  );

  return loaded
    .filter((diagnosis): diagnosis is Diagnosis => diagnosis !== null)
    .filter((diagnosis) => !scopeKey || diagnosis.scopeKey === scopeKey)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map(summarizeDiagnosis);
}
