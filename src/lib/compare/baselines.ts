import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_BASELINES_DIRNAME,
  baselineImageUrl,
  baselineScopeKey,
  isValidBaselineVersionFileName,
  isValidBaselineVersionId,
  parseBaselineScope,
  resolveBaselineLockPath,
  resolveBaselineManifestPath,
  resolveBaselineVersionPath,
  resolveBaselinesDir,
  scopeKindOfManifest,
  versionFileName,
} from "./baseline-paths";
import { decodePng } from "./diff";
import { ComparisonError } from "./errors";
import { LockTimeoutError, withFileLock } from "./file-lock";
import { sha256Hex, verifyImageIntegrity } from "./integrity";
import { readArtifact, readReport, scopeKeyOf } from "./storage";
import { getTarget, getViewport } from "./targets";
import type { BaselineManifest, BaselineReference, BaselineScope, BaselineVersion, ViewportPreset } from "./types";

/**
 * Approved baselines, stored beside the run reports.
 *
 * A baseline belongs to one **scope** (a demo target, or a project route) and one
 * viewport, which is what keeps a project's reference image from ever being compared
 * against — or overwritten by — another project's, or a demo fixture's.
 *
 * Guarantees this module is responsible for:
 *  · **Append-only versions.** Approving writes a new PNG with the `wx` flag, so an
 *    existing approved image can never be overwritten or silently replaced.
 *  · **Atomic metadata.** `manifest.json` is always written to a temporary file in the
 *    same directory and renamed over the old one, so a reader never sees half a manifest.
 *  · **Cross-process exclusion.** Every mutation holds a filesystem lock
 *    (`.manifest.lock`, taken with an atomic `mkdir`) for the whole read-modify-write, so
 *    two UIProof processes approving for the same scope cannot lose an update.
 *  · **Optimistic check as a second line.** After releasing, the stored manifest is
 *    compared with what was intended; a mismatch retries on top of the newer state.
 *  · **Ownership.** Paths come from the validated scope, a run may only be adopted for
 *    the scope it was captured for, and a manifest whose rows disagree with its own scope
 *    is treated as unreadable rather than trusted.
 */

const MAX_WRITE_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15;

/** In-process serialisation per scope; the file lock covers other processes. */
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

function requireScope(scope: unknown): BaselineScope {
  try {
    return parseBaselineScope(scope);
  } catch (cause) {
    throw new ComparisonError("invalid_target", (cause as Error).message, { cause });
  }
}

function requireViewport(viewportId: unknown): ViewportPreset {
  const viewport = getViewport(viewportId);
  if (!viewport) {
    throw new ComparisonError("invalid_viewport", `Unknown viewport preset: ${String(viewportId)}`);
  }
  return viewport;
}

/** Narrows an approved version to the reference block a comparison report carries. */
export function toBaselineReference(version: BaselineVersion): BaselineReference {
  return {
    versionId: version.id,
    approvedAt: version.approvedAt,
    sourceReportId: version.sourceReportId,
    capturedRoute: version.capturedRoute,
    origin: version.origin ?? "",
    width: version.width,
    height: version.height,
    imageUrl: version.imageUrl,
  };
}

function manifestIsForScope(candidate: Partial<BaselineManifest>, scope: BaselineScope, targetId: string): boolean {
  if (scopeKindOfManifest(candidate) !== scope.kind) return false;
  if (scope.kind === "project") {
    return candidate.projectId === scope.projectId && candidate.routeId === scope.routeId;
  }
  return candidate.targetId === targetId && candidate.projectId == null;
}

function versionBelongsToScope(version: Partial<BaselineVersion>, scope: BaselineScope): boolean {
  if (!isValidBaselineVersionId(version?.id)) return false;
  if (scopeKindOfManifest(version) !== scope.kind) return false;
  if (scope.kind === "project") {
    return version.projectId === scope.projectId && version.routeId === scope.routeId;
  }
  return version.targetId === scope.targetId && version.projectId == null;
}

function parseManifest(raw: string, scope: BaselineScope, viewportId: string): BaselineManifest {
  const label = baselineScopeKey(scope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ComparisonError("baseline_unreadable", `The baseline manifest for ${label} is not readable JSON.`, {
      cause,
    });
  }
  const candidate = parsed as Partial<BaselineManifest> | null;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.versions)) {
    throw new ComparisonError("baseline_unreadable", `The baseline manifest for ${label} is missing its version list.`);
  }

  const targetId = scope.kind === "demo" ? scope.targetId : scope.projectId;
  if (!manifestIsForScope(candidate, scope, targetId)) {
    throw new ComparisonError(
      "baseline_unreadable",
      `The baseline manifest for ${label} belongs to a different ${scope.kind === "project" ? "project route" : "target"}.`,
    );
  }
  // Ownership: a row that claims another scope is corruption, not data.
  for (const version of candidate.versions) {
    if (!versionBelongsToScope(version, scope)) {
      throw new ComparisonError(
        "baseline_unreadable",
        `The baseline manifest for ${label} contains a version that belongs elsewhere.`,
      );
    }
  }

  const active =
    typeof candidate.activeVersionId === "string" &&
    candidate.versions.some((version) => version.id === candidate.activeVersionId)
      ? candidate.activeVersionId
      : null;

  return {
    scope: scope.kind,
    targetId,
    targetLabel: typeof candidate.targetLabel === "string" ? candidate.targetLabel : targetId,
    projectId: scope.kind === "project" ? scope.projectId : null,
    routeId: scope.kind === "project" ? scope.routeId : null,
    viewportId,
    viewportLabel: typeof candidate.viewportLabel === "string" ? candidate.viewportLabel : viewportId,
    activeVersionId: active,
    revision: typeof candidate.revision === "number" && Number.isFinite(candidate.revision) ? candidate.revision : 0,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    versions: candidate.versions as BaselineVersion[],
  };
}

async function readManifestFile(
  scope: BaselineScope,
  viewportId: string,
  cwd?: string,
): Promise<BaselineManifest | null> {
  try {
    const raw = await readFile(resolveBaselineManifestPath(scope, viewportId, cwd), "utf8");
    return parseManifest(raw, scope, viewportId);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw cause;
  }
}

/** Reads the manifest for one scope and viewport. `null` means nothing approved yet. */
export async function readBaselineManifest(
  scope: unknown,
  viewportId: unknown,
  cwd?: string,
): Promise<BaselineManifest | null> {
  const parsed = requireScope(scope);
  requireViewport(viewportId);
  try {
    return await readManifestFile(parsed, viewportId as string, cwd);
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    if (cause instanceof RangeError) {
      throw new ComparisonError("storage_failed", cause.message, { cause });
    }
    throw new ComparisonError(
      "baseline_unreadable",
      `The baseline manifest for ${baselineScopeKey(parsed)} could not be read.`,
      { cause },
    );
  }
}

export function findActiveVersion(manifest: BaselineManifest | null): BaselineVersion | null {
  if (!manifest || manifest.activeVersionId === null) return null;
  return manifest.versions.find((version) => version.id === manifest.activeVersionId) ?? null;
}

async function writeManifestAtomic(manifest: BaselineManifest, scope: BaselineScope, cwd?: string): Promise<void> {
  const file = resolveBaselineManifestPath(scope, manifest.viewportId, cwd);
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
      `Could not write the baseline manifest for ${baselineScopeKey(scope)}.`,
      { cause },
    );
  }
}

/**
 * Read-modify-write under the cross-process lock, with an optimistic check afterwards:
 * the manifest is re-read and compared with what was intended, and a concurrent change
 * makes that comparison fail so the mutation is retried on top of the newer manifest.
 */
async function mutateManifest(
  scope: BaselineScope,
  viewportId: string,
  cwd: string | undefined,
  mutate: (current: BaselineManifest | null, attempt: number) => BaselineManifest,
): Promise<BaselineManifest> {
  const key = `${baselineScopeKey(scope)}/${viewportId}`;
  const lockPath = resolveBaselineLockPath(scope, viewportId, cwd);

  return withKeyLock(key, async () => {
    try {
      return await withFileLock(lockPath, async () => {
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
          const current = await readManifestFile(scope, viewportId, cwd);
          const next = mutate(current, attempt);
          await writeManifestAtomic(next, scope, cwd);
          const stored = await readManifestFile(scope, viewportId, cwd);
          if (stored && JSON.stringify(stored) === JSON.stringify(next)) return stored;
          await delay(RETRY_DELAY_MS * (attempt + 1));
        }
        throw new ComparisonError(
          "baseline_conflict",
          "Another approval was writing at the same time. Nothing was lost — run it again.",
        );
      });
    } catch (cause) {
      if (cause instanceof LockTimeoutError) {
        throw new ComparisonError(
          "baseline_conflict",
          `Another UIProof process is approving for ${baselineScopeKey(scope)} right now. Nothing was changed — try again in a moment.`,
          { cause },
        );
      }
      throw cause;
    }
  });
}

export interface ApproveBaselineInput {
  /** Phase 3 scope object: `{ kind: "demo", targetId }` or `{ kind: "project", … }`. */
  readonly scope: unknown;
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
 * Approves the `current.png` of an existing run as a new baseline version of one scope.
 *
 * The run has to belong to the same scope — approving a Desktop capture as the Mobile
 * baseline, or one project's run as another project's reference, is refused rather than
 * silently accepted — and the stored file is decoded before it is adopted, so a truncated
 * PNG can never become the reference image. Approving is always explicit: nothing in the
 * engine calls this.
 */
export async function approveBaseline(input: ApproveBaselineInput): Promise<ApproveBaselineResult> {
  const scope = requireScope(input.scope);
  const viewport = requireViewport(input.viewportId);
  const note = parseNote(input.note);

  const report = await readReport(input.sourceReportId);
  if (!report) {
    throw new ComparisonError(
      "report_not_found",
      `No stored run with id ${String(input.sourceReportId)} — run a comparison first.`,
    );
  }

  const missingArtifact = !report.artifacts.current;
  if (missingArtifact) {
    throw new ComparisonError("storage_failed", `Run ${report.id} has no stored screenshot to approve.`);
  }

  const runScopeKey = scopeKeyOf(report);
  if (runScopeKey !== baselineScopeKey(scope)) {
    throw new ComparisonError(
      "baseline_source_mismatch",
      `Run ${report.id} captured ${runScopeKey}. A baseline for ${baselineScopeKey(scope)} must come from a run of that ${scope.kind === "project" ? "project route" : "target"}.`,
    );
  }
  if (report.viewport.id !== viewport.id) {
    throw new ComparisonError(
      "baseline_source_mismatch",
      `Run ${report.id} captured ${report.viewport.label} at ${report.viewport.width}×${report.viewport.height}. A ${viewport.label} baseline must come from a ${viewport.label} run.`,
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

  const labelForDemo = scope.kind === "demo" ? (getTarget(scope.targetId)?.label ?? scope.targetId) : null;
  const versionId = `bl-${randomUUID()}`;
  const approvedAt = new Date().toISOString();
  const origin = report.source?.origin ?? null;

  const version: BaselineVersion = {
    id: versionId,
    scope: scope.kind,
    targetId: scope.kind === "demo" ? scope.targetId : scope.projectId,
    projectId: scope.kind === "project" ? scope.projectId : null,
    routeId: scope.kind === "project" ? scope.routeId : null,
    routeName: scope.kind === "project" ? (report.source?.routeName ?? null) : null,
    viewportId: viewport.id,
    viewportLabel: viewport.label,
    approvedAt,
    sourceReportId: report.id,
    capturedRoute: report.source?.path ?? report.target.currentPath,
    origin,
    width: size.width,
    height: size.height,
    bytes: png.byteLength,
    note,
    imageUrl: baselineImageUrl(scope, viewport.id, versionId),
  };

  const versionPath = resolveBaselineVersionPath(scope, viewport.id, versionId);
  await mkdir(path.dirname(versionPath), { recursive: true });
  try {
    // `wx` fails instead of overwriting: an approved image is immutable.
    await writeFile(versionPath, png, { flag: "wx" });
  } catch (cause) {
    throw new ComparisonError("storage_failed", `Could not store baseline image ${versionId}.`, { cause });
  }

  try {
    const manifest = await mutateManifest(scope, viewport.id, undefined, (current, attempt) => ({
      scope: scope.kind,
      targetId: version.targetId,
      targetLabel:
        current?.targetLabel ??
        (scope.kind === "demo" ? (labelForDemo ?? scope.targetId) : (report.source?.label ?? scope.projectId)),
      projectId: scope.kind === "project" ? scope.projectId : null,
      routeId: scope.kind === "project" ? scope.routeId : null,
      viewportId: viewport.id,
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
  readonly scope: unknown;
  readonly viewportId: unknown;
  readonly versionId: unknown;
}

/**
 * Makes an existing version the one new runs compare against — the explicit way to
 * replace or restore a baseline without touching history. The approved images stay on
 * disk, and re-activating the current version changes nothing.
 */
export async function activateBaselineVersion(input: ActivateBaselineInput): Promise<BaselineManifest> {
  const scope = requireScope(input.scope);
  const viewport = requireViewport(input.viewportId);

  if (!isValidBaselineVersionId(input.versionId)) {
    throw new ComparisonError("baseline_version_unknown", `Unknown baseline version: ${String(input.versionId)}`);
  }
  const versionId = input.versionId;

  const existing = await readBaselineManifest(scope, viewport.id);
  if (!existing) {
    throw new ComparisonError(
      "baseline_not_found",
      `No approved baseline exists for ${baselineScopeKey(scope)} at ${viewport.label} yet.`,
    );
  }
  if (!existing.versions.some((version) => version.id === versionId)) {
    throw new ComparisonError(
      "baseline_version_unknown",
      `Version ${versionId} is not part of the ${viewport.label} baseline history for ${baselineScopeKey(scope)}.`,
    );
  }
  if (existing.activeVersionId === versionId) return existing;

  return mutateManifest(scope, viewport.id, undefined, (current, attempt) => {
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
  scope: unknown,
  viewportId: unknown,
  fileName: unknown,
  cwd?: string,
): Promise<Buffer> {
  const parsed = requireScope(scope);
  requireViewport(viewportId);
  if (!isValidBaselineVersionFileName(fileName)) {
    throw new ComparisonError("baseline_version_unknown", "Unknown baseline image requested");
  }
  const versionId = fileName.slice(0, -".png".length);
  try {
    return await readFile(resolveBaselineVersionPath(parsed, viewportId as string, versionId, cwd));
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ComparisonError("baseline_version_unknown", cause.message, { cause });
    }
    throw new ComparisonError("baseline_not_found", "That baseline image is no longer on disk.", { cause });
  }
}

/**
 * Every baseline this machine has stored, in a stable order. Used by the CLI to report
 * status and to build a portable bundle; the web console never needs it.
 *
 * Discovery is deliberately defensive: a directory that is not a valid scope or viewport
 * is skipped rather than guessed at, and a manifest that does not belong to the scope it
 * sits in is reported as unreadable by `readBaselineManifest` instead of being trusted.
 */
export async function listStoredBaselines(
  cwd?: string,
): Promise<Array<{ readonly scope: BaselineScope; readonly viewportId: string; readonly manifest: BaselineManifest }>> {
  const baselinesDir = resolveBaselinesDir(cwd);
  const found: Array<{ scope: BaselineScope; viewportId: string }> = [];

  async function collect(scope: BaselineScope, directory: string): Promise<void> {
    const viewports = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of viewports) {
      if (!entry.isDirectory() || !getViewport(entry.name)) continue;
      found.push({ scope, viewportId: entry.name });
    }
  }

  const targets = await readdir(baselinesDir, { withFileTypes: true }).catch(() => []);
  for (const target of targets) {
    if (!target.isDirectory()) continue;
    if (target.name !== PROJECT_BASELINES_DIRNAME) {
      const scope = tryScope({ kind: "demo", targetId: target.name });
      if (scope) await collect(scope, path.join(baselinesDir, target.name));
      continue;
    }
    const projects = await readdir(path.join(baselinesDir, target.name), { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const routes = await readdir(path.join(baselinesDir, target.name, project.name), { withFileTypes: true }).catch(() => []);
      for (const route of routes) {
        if (!route.isDirectory()) continue;
        const scope = tryScope({ kind: "project", projectId: project.name, routeId: route.name });
        if (scope) await collect(scope, path.join(baselinesDir, target.name, project.name, route.name));
      }
    }
  }

  const stored: Array<{ scope: BaselineScope; viewportId: string; manifest: BaselineManifest }> = [];
  for (const entry of found.sort((a, b) =>
    baselineScopeKey(a.scope).localeCompare(baselineScopeKey(b.scope)) || a.viewportId.localeCompare(b.viewportId),
  )) {
    const manifest = await readBaselineManifest(entry.scope, entry.viewportId, cwd);
    if (manifest) stored.push({ ...entry, manifest });
  }
  return stored;
}

function tryScope(value: unknown): BaselineScope | null {
  try {
    return parseBaselineScope(value);
  } catch {
    return null;
  }
}

/** Reads one approved version's bytes from the store, for export. */
export async function readBaselineVersionBytes(
  scope: unknown,
  viewportId: unknown,
  versionId: unknown,
  cwd?: string,
): Promise<Buffer> {
  if (!isValidBaselineVersionId(versionId)) {
    throw new ComparisonError("baseline_version_unknown", `Unknown baseline version: ${String(versionId)}`);
  }
  return readBaselineImage(scope, viewportId, versionFileName(versionId), cwd);
}

/**
 * Installs a version that came from a portable bundle.
 *
 * This is the one write path that has no local run behind it, so it repeats the store's
 * invariants rather than trusting the bundle: the image must decode, the version id must
 * be one of ours, an existing version is never overwritten (a different image under the
 * same id is a conflict, an identical one is a no-op), and the manifest is updated under
 * the same cross-process lock as an approval. It is also an explicit act: unless
 * `activate` is set, importing a version never changes which reference new runs use.
 */
export interface ImportBaselineVersionInput {
  readonly scope: unknown;
  readonly viewportId: unknown;
  readonly versionId: unknown;
  readonly png: Buffer;
  /** Recorded hashes the import has already checked; re-verified here as a second gate. */
  readonly expectedSha256?: string;
  readonly approvedAt: string;
  readonly sourceReportId: string;
  readonly capturedRoute: string;
  readonly note?: string | null;
  readonly routeName?: string | null;
  readonly origin?: string | null;
  readonly targetLabel?: string | null;
  readonly activate?: boolean;
  /** Store directory; the default is the resolved `UIPROOF_DATA_DIR`. */
  readonly cwd?: string;
}

export interface ImportBaselineVersionResult {
  readonly outcome: "added" | "already-present";
  readonly manifest: BaselineManifest;
  readonly version: BaselineVersion;
  readonly activeVersionId: string | null;
}

export async function importBaselineVersion(input: ImportBaselineVersionInput): Promise<ImportBaselineVersionResult> {
  const scope = requireScope(input.scope);
  const viewport = requireViewport(input.viewportId);
  if (!isValidBaselineVersionId(input.versionId)) {
    throw new ComparisonError(
      "portable_bundle_invalid",
      `Unknown baseline version id: ${String(input.versionId)}.`,
    );
  }
  const versionId = input.versionId;
  const label = baselineScopeKey(scope);
  const versionPath = resolveBaselineVersionPath(scope, viewport.id, versionId, input.cwd);

  const size = verifyImageIntegrity(input.png, { sha256: input.expectedSha256 }, `${versionId} of ${label}`);

  const existing = await readBaselineManifest(scope, viewport.id, input.cwd);
  const duplicate = existing?.versions.find((version) => version.id === versionId);
  if (duplicate) {
    const onDisk = await readFile(versionPath).catch(() => null);
    if (onDisk && sha256Hex(onDisk) === sha256Hex(input.png)) {
      // An identical image is not re-imported, but `activate` is still honoured: importing
      // the same bundle again with `--activate` is how a developer turns a version that is
      // already on this machine into the reference, without a second copy of anything.
      if (input.activate && existing!.activeVersionId !== versionId) {
        const activated = await mutateManifest(scope, viewport.id, input.cwd, (current, attempt) => {
          const base = current ?? existing!;
          return {
            ...base,
            activeVersionId: versionId,
            revision: base.revision + 1 + attempt,
            updatedAt: new Date().toISOString(),
          };
        });
        return {
          outcome: "already-present",
          manifest: activated,
          version: duplicate,
          activeVersionId: activated.activeVersionId,
        };
      }
      return { outcome: "already-present", manifest: existing!, version: duplicate, activeVersionId: existing!.activeVersionId };
    }
    throw new ComparisonError(
      "baseline_version_conflict",
      `${versionId} already exists for ${label} at ${viewport.label} with different image content. Approved versions are immutable — import a different version or clean the store deliberately.`,
    );
  }

  await mkdir(path.dirname(versionPath), { recursive: true });
  try {
    // `wx`, like every other approved image: an import can create a version, never rewrite one.
    await writeFile(versionPath, input.png, { flag: "wx" });
  } catch (cause) {
    throw new ComparisonError(
      "baseline_version_conflict",
      `${versionId} already exists on disk for ${label} at ${viewport.label}.`,
      { cause },
    );
  }

  const imported: BaselineVersion = {
    id: versionId,
    scope: scope.kind,
    targetId: scope.kind === "demo" ? scope.targetId : scope.projectId,
    projectId: scope.kind === "project" ? scope.projectId : null,
    routeId: scope.kind === "project" ? scope.routeId : null,
    routeName: scope.kind === "project" ? (input.routeName ?? null) : null,
    viewportId: viewport.id,
    viewportLabel: viewport.label,
    approvedAt: input.approvedAt,
    sourceReportId: input.sourceReportId,
    capturedRoute: input.capturedRoute,
    origin: input.origin ?? null,
    width: size.width,
    height: size.height,
    bytes: input.png.byteLength,
    note: input.note ?? null,
    imageUrl: baselineImageUrl(scope, viewport.id, versionId),
  };

  try {
    const manifest = await mutateManifest(scope, viewport.id, input.cwd, (current, attempt) => ({
      scope: scope.kind,
      targetId: imported.targetId,
      targetLabel: current?.targetLabel ?? input.targetLabel ?? imported.targetId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      routeId: scope.kind === "project" ? scope.routeId : null,
      viewportId: viewport.id,
      viewportLabel: viewport.label,
      activeVersionId: input.activate ? versionId : (current?.activeVersionId ?? null),
      revision: (current?.revision ?? 0) + 1 + attempt,
      updatedAt: new Date().toISOString(),
      versions: [...(current?.versions ?? []), imported],
    }));
    return { outcome: "added", manifest, version: imported, activeVersionId: manifest.activeVersionId };
  } catch (cause) {
    // The image never reached a manifest, so it must not linger as an orphan.
    await rm(versionPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** Loads the approved image an engine run should diff against, plus its metadata. */
export async function readActiveBaseline(
  scope: unknown,
  viewportId: unknown,
  cwd?: string,
): Promise<{ manifest: BaselineManifest; version: BaselineVersion; png: Buffer } | null> {
  const parsed = requireScope(scope);
  const manifest = await readBaselineManifest(parsed, viewportId, cwd);
  const version = findActiveVersion(manifest);
  if (!manifest || !version) return null;
  const png = await readBaselineImage(parsed, viewportId, versionFileName(version.id), cwd);
  return { manifest, version, png };
}
