import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baselineImageUrl,
  isValidBaselineVersionFileName,
  isValidBaselineVersionId,
  resolveBaselineManifestPath,
  resolveBaselineVersionPath,
  versionFileName,
} from "./baseline-paths";
import { decodePng } from "./diff";
import { ComparisonError } from "./errors";
import { readArtifact, readReport } from "./storage";
import { getTarget, getViewport } from "./targets";
import type { BaselineManifest, BaselineReference, BaselineVersion, ViewportPreset } from "./types";

/** Narrows an approved version to the reference block a comparison report carries. */
export function toBaselineReference(version: BaselineVersion): BaselineReference {
  return {
    versionId: version.id,
    approvedAt: version.approvedAt,
    sourceReportId: version.sourceReportId,
    capturedRoute: version.capturedRoute,
    width: version.width,
    height: version.height,
    imageUrl: version.imageUrl,
  };
}

/**
 * Approved baselines, stored beside the run reports.
 *
 * Guarantees this module is responsible for:
 *  · **Append-only versions.** Approving writes a new PNG with the `wx` flag, so an
 *    existing approved image can never be overwritten or silently replaced.
 *  · **Atomic metadata.** `manifest.json` is always written to a temporary file in the
 *    same directory and renamed over the old one, so a reader never sees half a manifest.
 *  · **Optimistic concurrency.** Every metadata write re-reads the manifest and retries
 *    when another approval landed in between, which keeps two simultaneous approvals as
 *    two versions instead of one lost update.
 *  · **Ownership.** Paths come from the target/viewport catalogue, and a manifest whose
 *    rows disagree with its own directory is treated as unreadable rather than trusted.
 */

const MAX_WRITE_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15;

/** In-process serialisation per target/viewport; the optimistic check covers other processes. */
const writeChains = new Map<string, Promise<unknown>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function requireTargetAndViewport(targetId: unknown, viewportId: unknown): { targetLabel: string; viewport: ViewportPreset } {
  const target = getTarget(targetId);
  if (!target) {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${String(targetId)}`);
  }
  const viewport = getViewport(viewportId);
  if (!viewport) {
    throw new ComparisonError("invalid_viewport", `Unknown viewport preset: ${String(viewportId)}`);
  }
  return { targetLabel: target.label, viewport };
}

function parseManifest(raw: string, targetId: string, viewportId: string): BaselineManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ComparisonError(
      "baseline_unreadable",
      `The baseline manifest for ${targetId}/${viewportId} is not readable JSON.`,
      { cause },
    );
  }
  const candidate = parsed as Partial<BaselineManifest> | null;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.versions)) {
    throw new ComparisonError(
      "baseline_unreadable",
      `The baseline manifest for ${targetId}/${viewportId} is missing its version list.`,
    );
  }
  // Ownership: a row that claims another target or viewport is corruption, not data.
  for (const version of candidate.versions) {
    if (
      !isValidBaselineVersionId(version?.id) ||
      version.targetId !== targetId ||
      version.viewportId !== viewportId
    ) {
      throw new ComparisonError(
        "baseline_unreadable",
        `The baseline manifest for ${targetId}/${viewportId} contains a version that belongs elsewhere.`,
      );
    }
  }
  const active =
    typeof candidate.activeVersionId === "string" &&
    candidate.versions.some((version) => version.id === candidate.activeVersionId)
      ? candidate.activeVersionId
      : null;
  return {
    targetId,
    targetLabel: typeof candidate.targetLabel === "string" ? candidate.targetLabel : targetId,
    viewportId,
    viewportLabel: typeof candidate.viewportLabel === "string" ? candidate.viewportLabel : viewportId,
    activeVersionId: active,
    revision: typeof candidate.revision === "number" && Number.isFinite(candidate.revision) ? candidate.revision : 0,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    versions: candidate.versions as BaselineVersion[],
  };
}

async function readManifestFile(
  targetId: string,
  viewportId: string,
  cwd?: string,
): Promise<BaselineManifest | null> {
  try {
    const raw = await readFile(resolveBaselineManifestPath(targetId, viewportId, cwd), "utf8");
    return parseManifest(raw, targetId, viewportId);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw cause;
  }
}

/** Reads the manifest for one target/viewport pair. `null` means nothing approved yet. */
export async function readBaselineManifest(
  targetId: unknown,
  viewportId: unknown,
  cwd?: string,
): Promise<BaselineManifest | null> {
  requireTargetAndViewport(targetId, viewportId);
  try {
    return await readManifestFile(targetId as string, viewportId as string, cwd);
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    if (cause instanceof RangeError) {
      throw new ComparisonError("storage_failed", cause.message, { cause });
    }
    throw new ComparisonError(
      "baseline_unreadable",
      `The baseline manifest for ${String(targetId)}/${String(viewportId)} could not be read.`,
      { cause },
    );
  }
}

export function findActiveVersion(manifest: BaselineManifest | null): BaselineVersion | null {
  if (!manifest || manifest.activeVersionId === null) return null;
  return manifest.versions.find((version) => version.id === manifest.activeVersionId) ?? null;
}

async function writeManifestAtomic(manifest: BaselineManifest, cwd?: string): Promise<void> {
  const file = resolveBaselineManifestPath(manifest.targetId, manifest.viewportId, cwd);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const tempFile = path.join(directory, `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(tempFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(tempFile, file);
  } catch (cause) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw new ComparisonError(
      "storage_failed",
      `Could not write the baseline manifest for ${manifest.targetId}/${manifest.viewportId}.`,
      { cause },
    );
  }
}

/**
 * Read-modify-write with an optimistic check: the manifest is re-read after the write
 * and compared byte-for-byte with what was intended. A concurrent approval makes that
 * comparison fail, and the mutation is retried on top of the newer manifest instead of
 * clobbering it.
 */
async function mutateManifest(
  targetId: string,
  viewportId: string,
  cwd: string | undefined,
  mutate: (current: BaselineManifest | null, attempt: number) => BaselineManifest,
): Promise<BaselineManifest> {
  return withKeyLock(`${targetId}/${viewportId}`, async () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readManifestFile(targetId, viewportId, cwd);
      const next = mutate(current, attempt);
      await writeManifestAtomic(next, cwd);
      const stored = await readManifestFile(targetId, viewportId, cwd);
      if (stored && JSON.stringify(stored) === JSON.stringify(next)) return stored;
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
    throw new ComparisonError(
      "baseline_conflict",
      "Another approval was writing at the same time. Nothing was lost — run it again.",
    );
  });
}

export interface ApproveBaselineInput {
  readonly targetId: unknown;
  readonly viewportId: unknown;
  readonly sourceReportId: unknown;
  readonly note?: unknown;
}

export interface ApproveBaselineResult {
  readonly manifest: BaselineManifest;
  readonly version: BaselineVersion;
}

function parseNote(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw new ComparisonError("invalid_options", "note must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) {
    throw new ComparisonError("invalid_options", "note must be 200 characters or fewer");
  }
  return trimmed;
}

/**
 * Approves the `current.png` of an existing run as a new baseline version.
 *
 * The run has to belong to the same target and viewport — approving a Desktop
 * capture as the Mobile baseline is refused rather than silently accepted — and the
 * stored file is decoded before it is adopted, so a truncated PNG can never become
 * the reference image. Approving is always explicit: nothing in the engine calls this.
 */
export async function approveBaseline(input: ApproveBaselineInput): Promise<ApproveBaselineResult> {
  const { targetLabel, viewport } = requireTargetAndViewport(input.targetId, input.viewportId);
  const targetId = input.targetId as string;
  const viewportId = viewport.id;
  const note = parseNote(input.note);

  const report = await readReport(input.sourceReportId);
  if (!report) {
    throw new ComparisonError(
      "report_not_found",
      `No stored run with id ${String(input.sourceReportId)} — run a comparison first.`,
    );
  }
  if (report.target.id !== targetId || report.viewport.id !== viewportId) {
    throw new ComparisonError(
      "baseline_source_mismatch",
      `Run ${report.id} captured ${report.target.label} at ${report.viewport.label}. A baseline for ${targetLabel} at ${viewport.label} must come from a matching run.`,
    );
  }

  const png = await readArtifact(report.id, "current.png");
  let size: { width: number; height: number };
  try {
    const decoded = decodePng(png);
    size = { width: decoded.width, height: decoded.height };
  } catch (cause) {
    throw new ComparisonError(
      "storage_failed",
      `Run ${report.id} has no decodable current.png, so it cannot become a baseline.`,
      { cause },
    );
  }

  const versionId = `bl-${randomUUID()}`;
  const approvedAt = new Date().toISOString();
  const version: BaselineVersion = {
    id: versionId,
    targetId,
    viewportId,
    viewportLabel: viewport.label,
    approvedAt,
    sourceReportId: report.id,
    capturedRoute: report.target.currentPath,
    width: size.width,
    height: size.height,
    bytes: png.byteLength,
    note,
    imageUrl: baselineImageUrl(targetId, viewportId, versionId),
  };

  const versionPath = resolveBaselineVersionPath(targetId, viewportId, versionId);
  await mkdir(path.dirname(versionPath), { recursive: true });
  try {
    // `wx` fails instead of overwriting: an approved image is immutable.
    await writeFile(versionPath, png, { flag: "wx" });
  } catch (cause) {
    throw new ComparisonError("storage_failed", `Could not store baseline image ${versionId}.`, { cause });
  }

  try {
    const manifest = await mutateManifest(targetId, viewportId, undefined, (current, attempt) => ({
      targetId,
      targetLabel: current?.targetLabel ?? targetLabel,
      viewportId,
      viewportLabel: viewport.label,
      activeVersionId: versionId,
      revision: (current?.revision ?? 0) + 1 + attempt,
      updatedAt: new Date().toISOString(),
      versions: [...(current?.versions ?? []), version],
    }));
    return { manifest, version };
  } catch (cause) {
    // The image never made it into a manifest, so it must not linger as an orphan.
    await rm(versionPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export interface ActivateBaselineInput {
  readonly targetId: unknown;
  readonly viewportId: unknown;
  readonly versionId: unknown;
}

/**
 * Makes an existing version the one new runs compare against — the explicit way to
 * replace or restore a baseline without touching history. The approved images stay on
 * disk, and re-activating the current version changes nothing.
 */
export async function activateBaselineVersion(input: ActivateBaselineInput): Promise<BaselineManifest> {
  const { viewport } = requireTargetAndViewport(input.targetId, input.viewportId);
  const targetId = input.targetId as string;
  const viewportId = viewport.id;

  if (!isValidBaselineVersionId(input.versionId)) {
    throw new ComparisonError("baseline_version_unknown", `Unknown baseline version: ${String(input.versionId)}`);
  }
  const versionId = input.versionId;

  const existing = await readBaselineManifest(targetId, viewportId);
  if (!existing) {
    throw new ComparisonError(
      "baseline_not_found",
      `No approved baseline exists for ${targetId} at ${viewport.label} yet.`,
    );
  }
  if (!existing.versions.some((version) => version.id === versionId)) {
    throw new ComparisonError(
      "baseline_version_unknown",
      `Version ${versionId} is not part of the ${viewport.label} baseline history.`,
    );
  }
  if (existing.activeVersionId === versionId) return existing;

  return mutateManifest(targetId, viewportId, undefined, (current, attempt) => {
    const base = current ?? existing;
    return {
      ...base,
      activeVersionId: versionId,
      revision: base.revision + 1 + attempt,
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Reads one approved baseline image, validating both path segments first. */
export async function readBaselineImage(
  targetId: unknown,
  viewportId: unknown,
  fileName: unknown,
  cwd?: string,
): Promise<Buffer> {
  requireTargetAndViewport(targetId, viewportId);
  if (!isValidBaselineVersionFileName(fileName)) {
    throw new ComparisonError("baseline_version_unknown", "Unknown baseline image requested");
  }
  const versionId = fileName.slice(0, -".png".length);
  try {
    return await readFile(resolveBaselineVersionPath(targetId, viewportId, versionId, cwd));
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ComparisonError("baseline_version_unknown", cause.message, { cause });
    }
    throw new ComparisonError("baseline_not_found", "That baseline image is no longer on disk.", { cause });
  }
}

/** Loads the approved image an engine run should diff against, plus its metadata. */
export async function readActiveBaseline(
  targetId: unknown,
  viewportId: unknown,
  cwd?: string,
): Promise<{ manifest: BaselineManifest; version: BaselineVersion; png: Buffer } | null> {
  const manifest = await readBaselineManifest(targetId, viewportId, cwd);
  const version = findActiveVersion(manifest);
  if (!manifest || !version) return null;
  const png = await readBaselineImage(targetId, viewportId, versionFileName(version.id), cwd);
  return { manifest, version, png };
}
