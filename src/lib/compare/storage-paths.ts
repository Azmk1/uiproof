/**
 * Path-level storage rules for generated artifacts. Kept free of filesystem
 * calls so the traversal guards can be unit tested directly.
 */
import path from "node:path";

export const DEFAULT_DATA_DIRNAME = ".uiproof";

export const ARTIFACT_FILENAMES = {
  baseline: "baseline.png",
  current: "current.png",
  diff: "diff.png",
} as const;

export type ArtifactName = keyof typeof ARTIFACT_FILENAMES;
export const ARTIFACT_NAMES = Object.keys(ARTIFACT_FILENAMES) as readonly ArtifactName[];
export const REPORT_FILENAME = "report.json";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SAFE_FILENAME = /^[a-z0-9][a-z0-9-]{0,31}\.(png|json)$/;

/** Artifacts live outside `.next` but inside the project so they survive restarts. */
export function resolveDataDir(cwd: string = process.cwd()): string {
  const override = process.env.UIPROOF_DATA_DIR;
  if (override && override.trim().length > 0) return path.resolve(cwd, override.trim());
  return path.join(cwd, DEFAULT_DATA_DIRNAME, "data");
}

export function resolveReportsDir(cwd?: string): string {
  return path.join(resolveDataDir(cwd), "reports");
}

export function isValidReportId(id: unknown): id is string {
  return typeof id === "string" && SAFE_ID.test(id) && !id.includes("..") && !id.includes("/");
}

export function isValidFileName(name: unknown): name is string {
  return typeof name === "string" && SAFE_FILENAME.test(name) && !name.includes("..") && !name.includes("/");
}

export function isArtifactName(value: unknown): value is ArtifactName {
  return typeof value === "string" && (ARTIFACT_NAMES as readonly string[]).includes(value);
}

function assertInside(parent: string, candidate: string): string {
  const resolvedParent = path.resolve(parent);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedParent && !resolved.startsWith(resolvedParent + path.sep)) {
    throw new RangeError(`Refusing to access a path outside the data directory: ${candidate}`);
  }
  return resolved;
}

/** Absolute path of one run directory. Throws for unsafe ids. */
export function resolveReportDir(reportId: unknown, cwd?: string): string {
  if (!isValidReportId(reportId)) {
    throw new RangeError(`Invalid report id: ${String(reportId)}`);
  }
  const reportsDir = resolveReportsDir(cwd);
  return assertInside(reportsDir, path.join(reportsDir, reportId));
}

/** Absolute path of a stored artifact, guarded against traversal. */
export function resolveArtifactPath(reportId: unknown, fileName: unknown, cwd?: string): string {
  if (!isValidFileName(fileName)) {
    throw new RangeError(`Invalid artifact file name: ${String(fileName)}`);
  }
  const reportDir = resolveReportDir(reportId, cwd);
  return assertInside(reportDir, path.join(reportDir, fileName));
}
