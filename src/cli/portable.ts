import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_BASELINES_DIRNAME,
  baselineScopeKey,
  isValidBaselineVersionId,
  parseBaselineScope,
  resolveBaselinesDir,
  versionFileName,
} from "@/lib/compare/baseline-paths";
import { importBaselineVersion, listStoredBaselines, readBaselineVersionBytes } from "@/lib/compare/baselines";
import { ComparisonError } from "@/lib/compare/errors";
import {
  BASELINE_PORTABLE_FORMAT,
  BASELINE_PORTABLE_FORMAT_VERSION,
  isSha256,
  sha256Hex,
  verifyImageIntegrity,
} from "@/lib/compare/integrity";
import { getViewport } from "@/lib/compare/targets";
import type { BaselineManifest, BaselineScope } from "@/lib/compare/types";

/**
 * Portable approved baselines.
 *
 * The store under `.uiproof/data` is runtime state: ignored by git, wiped by a container,
 * gone on a fresh CI runner. A **bundle** is the canonical, committable form of the same
 * approvals — a directory that can be checked into a repository next to the code and
 * loaded by a clean machine:
 *
 *   uiproof-baselines/
 *   ├── uiproof-baselines.json                          every scope, version and SHA-256
 *   └── scopes/
 *       ├── demo/<targetId>/<viewport>/versions/bl-<uuid>.png
 *       └── projects/<projectId>/<routeId>/<viewport>/versions/bl-<uuid>.png
 *
 * The layout mirrors the store so a human can read it, but nothing about an import trusts
 * the file names inside a bundle: every path is re-derived from the validated scope, every
 * image is checked against its recorded size and SHA-256, and the store's own rules
 * (append-only versions, immutable images, explicit activation) still apply. Reports stay
 * in the store: a bundle carries references, never comparison results.
 */

export const BUNDLE_MANIFEST_FILENAME = "uiproof-baselines.json";
export const BUNDLE_SCOPES_DIRNAME = "scopes";
export const BUNDLE_VERSIONS_DIRNAME = "versions";

export interface PortableVersion {
  readonly id: string;
  /** Bundle-relative path; required to equal the path derived from the scope. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly approvedAt: string;
  readonly sourceReportId: string;
  readonly capturedRoute: string;
  readonly note: string | null;
}

export interface PortableScope {
  readonly kind: "demo" | "project";
  readonly targetId: string;
  readonly projectId: string | null;
  readonly routeId: string | null;
  /** Human labels, for reviewing a bundle without the store. */
  readonly targetLabel: string;
  readonly routeName: string | null;
  readonly origin: string | null;
  readonly viewportId: string;
  readonly viewportLabel: string;
  readonly activeVersionId: string | null;
  readonly versions: readonly PortableVersion[];
}

export interface PortableBundle {
  readonly format: typeof BASELINE_PORTABLE_FORMAT;
  readonly formatVersion: typeof BASELINE_PORTABLE_FORMAT_VERSION;
  readonly generator: string;
  readonly exportedAt: string;
  readonly scopes: readonly PortableScope[];
}

function invalid(message: string, cause?: unknown): ComparisonError {
  return new ComparisonError("portable_bundle_invalid", message, cause ? { cause } : undefined);
}

/** Where one version's PNG lives inside a bundle. The only spelling an import accepts. */
export function bundleVersionRelativePath(scope: BaselineScope, viewportId: string, versionId: string): string {
  const file = path.posix.join(BUNDLE_VERSIONS_DIRNAME, versionFileName(versionId));
  if (scope.kind === "demo") {
    return path.posix.join(BUNDLE_SCOPES_DIRNAME, "demo", scope.targetId, viewportId, file);
  }
  return path.posix.join(
    BUNDLE_SCOPES_DIRNAME,
    PROJECT_BASELINES_DIRNAME,
    scope.projectId,
    scope.routeId,
    viewportId,
    file,
  );
}

/** Resolves a bundle-relative path, refusing anything that escapes the bundle root. */
export function resolveBundlePath(root: string, relative: unknown, what: string): string {
  if (typeof relative !== "string" || relative.length === 0) {
    throw invalid(`${what} is missing its path inside the bundle.`);
  }
  if (relative.includes("\\") || relative.startsWith("/") || path.posix.isAbsolute(relative)) {
    throw invalid(`${what} has an unusable bundle path: ${relative}.`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw invalid(`${what} points outside the bundle: ${relative}.`);
  }
  return resolved;
}

function readString(source: Record<string, unknown>, key: string, what: string, allowNull = false): string | null {
  const value = source[key];
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw invalid(`${what} is missing "${key}".`);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${what} has an unusable "${key}".`);
  }
  return value;
}

function parsePortableVersion(input: unknown, scope: BaselineScope, viewportId: string, where: string): PortableVersion {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid(`${where} is not an object.`);
  }
  const source = input as Record<string, unknown>;
  const id = readString(source, "id", where);
  if (!isValidBaselineVersionId(id)) throw invalid(`${where} has an unusable version id: ${String(id)}`);

  const file = readString(source, "file", where);
  const expectedPath = bundleVersionRelativePath(scope, viewportId, id);
  if (file !== expectedPath) {
    throw invalid(`${where} declares the file "${file}", but this version must live at "${expectedPath}".`);
  }

  const sha256 = source.sha256;
  if (!isSha256(sha256)) throw invalid(`${where} has a missing or malformed SHA-256.`);

  const numeric = (key: string): number => {
    const value = source[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw invalid(`${where} has an unusable "${key}".`);
    }
    return value;
  };

  const approvedAt = readString(source, "approvedAt", where);
  if (Number.isNaN(Date.parse(approvedAt!))) throw invalid(`${where} has an unusable "approvedAt".`);
  const capturedRoute = readString(source, "capturedRoute", where);
  if (!capturedRoute!.startsWith("/")) throw invalid(`${where} has a "capturedRoute" that is not a path.`);

  return {
    id: id!,
    file: file!,
    sha256: sha256!,
    bytes: numeric("bytes"),
    width: numeric("width"),
    height: numeric("height"),
    approvedAt: approvedAt!,
    sourceReportId: readString(source, "sourceReportId", where)!,
    capturedRoute: capturedRoute!,
    note: typeof source.note === "string" ? source.note : null,
  };
}

function parsePortableScope(input: unknown, index: number): PortableScope {
  const where = `bundle scope #${index + 1}`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid(`${where} is not an object.`);
  const source = input as Record<string, unknown>;

  let scope: BaselineScope;
  try {
    scope = parseBaselineScope({
      kind: source.kind,
      targetId: source.targetId,
      projectId: source.projectId,
      routeId: source.routeId,
    });
  } catch (cause) {
    throw invalid(`${where} is not a scope this build can load.`, cause);
  }

  const viewportId = readString(source, "viewportId", where);
  const viewport = getViewport(viewportId);
  if (!viewport) throw invalid(`${where} names an unknown viewport: ${String(viewportId)}.`);

  const rawVersions = source.versions;
  if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
    throw invalid(`${where} has no versions.`);
  }
  const versions = rawVersions.map((version, versionIndex) =>
    parsePortableVersion(version, scope, viewportId!, `${where} version #${versionIndex + 1}`),
  );
  const ids = new Set<string>();
  for (const version of versions) {
    if (ids.has(version.id)) throw invalid(`${where} lists version ${version.id} twice.`);
    ids.add(version.id);
  }

  const activeVersionId = source.activeVersionId === null || source.activeVersionId === undefined
    ? null
    : readString(source, "activeVersionId", where);
  if (activeVersionId !== null && !ids.has(activeVersionId)) {
    throw invalid(`${where} claims an active version that is not in its version list.`);
  }

  return {
    kind: scope.kind,
    targetId: scope.kind === "demo" ? scope.targetId : "",
    projectId: scope.kind === "project" ? scope.projectId : null,
    routeId: scope.kind === "project" ? scope.routeId : null,
    targetLabel: typeof source.targetLabel === "string" && source.targetLabel.length > 0 ? source.targetLabel : baselineScopeKey(scope),
    routeName: typeof source.routeName === "string" ? source.routeName : null,
    origin: typeof source.origin === "string" ? source.origin : null,
    viewportId: viewportId!,
    viewportLabel: typeof source.viewportLabel === "string" && source.viewportLabel.length > 0 ? source.viewportLabel : viewport.label,
    activeVersionId,
    versions,
  };
}

/** Parses and validates a bundle manifest. Every rule an import depends on lives here. */
export function parsePortableBundle(raw: string): PortableBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw invalid(`The bundle manifest is not valid JSON: ${(cause as Error).message}`, cause);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("The bundle manifest must be a JSON object.");
  }
  const source = parsed as Record<string, unknown>;
  if (source.format !== BASELINE_PORTABLE_FORMAT) {
    throw invalid(
      `This is not a ${BASELINE_PORTABLE_FORMAT} bundle (found format ${JSON.stringify(source.format)}).`,
    );
  }
  if (source.formatVersion !== BASELINE_PORTABLE_FORMAT_VERSION) {
    throw invalid(
      `Unsupported bundle format version ${JSON.stringify(source.formatVersion)}; this build reads version ${BASELINE_PORTABLE_FORMAT_VERSION}.`,
    );
  }
  if (!Array.isArray(source.scopes)) throw invalid('The bundle manifest needs a "scopes" array.');

  return {
    format: BASELINE_PORTABLE_FORMAT,
    formatVersion: BASELINE_PORTABLE_FORMAT_VERSION,
    generator: typeof source.generator === "string" ? source.generator : "uiproof",
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : new Date(0).toISOString(),
    scopes: source.scopes.map(parsePortableScope),
  };
}

export function scopeOfPortableScope(input: PortableScope): BaselineScope {
  return input.kind === "demo"
    ? { kind: "demo", targetId: input.targetId }
    : { kind: "project", projectId: input.projectId!, routeId: input.routeId! };
}

function toPortableScope(
  scope: BaselineScope,
  manifest: BaselineManifest,
  files: ReadonlyMap<string, { sha256: string; bytes: number }>,
): PortableScope {
  const versions: PortableVersion[] = manifest.versions.map((version) => {
    const file = bundleVersionRelativePath(scope, manifest.viewportId, version.id);
    const identity = files.get(version.id);
    if (!identity) throw invalid(`No image was read for version ${version.id}.`);
    return {
      id: version.id,
      file,
      sha256: identity.sha256,
      bytes: identity.bytes,
      width: version.width,
      height: version.height,
      approvedAt: version.approvedAt,
      sourceReportId: version.sourceReportId,
      capturedRoute: version.capturedRoute,
      note: version.note,
    };
  });
  return {
    kind: scope.kind,
    targetId: scope.kind === "demo" ? scope.targetId : "",
    projectId: scope.kind === "project" ? scope.projectId : null,
    routeId: scope.kind === "project" ? scope.routeId : null,
    targetLabel: manifest.targetLabel,
    routeName: versions.length > 0 ? (manifest.versions.at(-1)?.routeName ?? null) : null,
    origin: manifest.versions.at(-1)?.origin ?? null,
    viewportId: manifest.viewportId,
    viewportLabel: manifest.viewportLabel,
    activeVersionId: manifest.activeVersionId,
    versions,
  };
}

export interface SelectBaselineScopes {
  readonly projectId?: string | null;
  readonly routeId?: string | null;
  readonly viewportId?: string | null;
  readonly all?: boolean;
}

/**
 * A selection with nothing set matches everything: importing a bundle without naming a
 * project is the normal CI case. `all` is not consulted here — it exists so `export` can
 * insist on an explicit scope or an explicit "everything" before it writes files.
 */
function matchesSelection(scope: BaselineScope, viewportId: string, selection: SelectBaselineScopes): boolean {
  if (selection.viewportId && selection.viewportId !== viewportId) return false;
  if (selection.projectId) {
    if (scope.kind !== "project" || scope.projectId !== selection.projectId) return false;
    if (selection.routeId && scope.routeId !== selection.routeId) return false;
  }
  return true;
}

export interface ExportPortableBaselinesOptions {
  readonly out: string;
  readonly selection: SelectBaselineScopes;
  readonly generator: string;
  /** Store directory; defaults to the resolved `UIPROOF_DATA_DIR`. */
  readonly cwd?: string;
}

export interface ExportPortableBaselinesResult {
  readonly manifestPath: string;
  readonly scopes: number;
  readonly versions: number;
  readonly bytes: number;
}

/**
 * Writes a bundle. Refreshing an existing bundle is allowed — that is how a developer
 * re-exports after approving a new baseline — but a file that is already there with
 * *different* content stops the export, so a committed bundle is never silently rewritten.
 */
export async function exportPortableBaselines(
  options: ExportPortableBaselinesOptions,
): Promise<ExportPortableBaselinesResult> {
  const stored = await listStoredBaselines(options.cwd);
  const selected = stored.filter((entry) => matchesSelection(entry.scope, entry.viewportId, options.selection));
  if (selected.length === 0) {
    const wanted = options.selection.projectId
      ? `project "${options.selection.projectId}"${options.selection.routeId ? ` route "${options.selection.routeId}"` : ""}${options.selection.viewportId ? ` at ${options.selection.viewportId}` : ""}`
      : "the selected scope";
    throw invalid(
      stored.length === 0
        ? "This machine has no approved baselines to export. Run capture --approve first."
        : `No approved baseline matches ${wanted}. Run capture --approve for it first, or export a different scope.`,
    );
  }

  const root = path.resolve(options.out);
  await mkdir(root, { recursive: true });

  const scopes: PortableScope[] = [];
  let versionCount = 0;
  let bytes = 0;

  for (const entry of selected) {
    const files = new Map<string, { sha256: string; bytes: number }>();
    const planned: Array<{ absolute: string; png: Buffer; versionId: string }> = [];
    for (const version of entry.manifest.versions) {
      const png = await readBaselineVersionBytes(entry.scope, entry.viewportId, version.id, options.cwd);
      verifyImageIntegrity(png, { bytes: version.bytes, width: version.width, height: version.height }, `${version.id}`);
      files.set(version.id, { sha256: sha256Hex(png), bytes: png.byteLength });
      planned.push({
        absolute: resolveBundlePath(root, bundleVersionRelativePath(entry.scope, entry.viewportId, version.id), version.id),
        png,
        versionId: version.id,
      });
    }

    const portable = toPortableScope(entry.scope, entry.manifest, files);
    scopes.push(portable);

    for (const file of planned) {
      await mkdir(path.dirname(file.absolute), { recursive: true });
      const existing = await readFile(file.absolute).catch(() => null);
      if (existing && !existing.equals(file.png)) {
        throw invalid(
          `${path.relative(root, file.absolute)} already exists in this bundle with different content. Exporting would rewrite an approved artifact — remove the bundle or choose another --out directory.`,
        );
      }
      if (!existing) await writeFile(file.absolute, file.png);
      versionCount += 1;
      bytes += file.png.byteLength;
    }
  }

  const bundle: PortableBundle = {
    format: BASELINE_PORTABLE_FORMAT,
    formatVersion: BASELINE_PORTABLE_FORMAT_VERSION,
    generator: options.generator,
    exportedAt: new Date().toISOString(),
    scopes,
  };
  const manifestPath = path.join(root, BUNDLE_MANIFEST_FILENAME);
  await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  return { manifestPath, scopes: scopes.length, versions: versionCount, bytes };
}

export interface ImportPortableBaselinesOptions {
  readonly from: string;
  readonly selection: SelectBaselineScopes;
  readonly activate: boolean;
  /** Store directory; defaults to the resolved `UIPROOF_DATA_DIR`. */
  readonly cwd?: string;
}

export interface ImportedScopeResult {
  readonly scope: BaselineScope;
  readonly viewportId: string;
  readonly added: number;
  readonly alreadyPresent: number;
  readonly activeVersionId: string | null;
  /** True when the bundle's active version is not the store's active version. */
  readonly activeMismatch: boolean;
}

export interface ImportPortableBaselinesResult {
  readonly scopes: readonly ImportedScopeResult[];
  readonly added: number;
  readonly alreadyPresent: number;
}

/**
 * Loads a bundle into the store.
 *
 * Every file is read through `resolveBundlePath` (inside the bundle), validated against
 * its recorded SHA-256, byte count and dimensions, and written through the store's own
 * import path — which refuses to overwrite a version and only changes the active
 * reference when `--activate` was passed. Importing the same bundle twice is a no-op.
 */
export async function importPortableBaselines(
  options: ImportPortableBaselinesOptions,
): Promise<ImportPortableBaselinesResult> {
  const root = path.resolve(options.from);
  const manifestFile = path.join(root, BUNDLE_MANIFEST_FILENAME);
  const raw = await readFile(manifestFile, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") {
      throw invalid(
        `No ${BUNDLE_MANIFEST_FILENAME} in ${root}. Point --from at a bundle produced by "uiproof baselines export".`,
      );
    }
    throw invalid(`The bundle manifest could not be read: ${cause.message}`, cause);
  });
  const bundle = parsePortableBundle(raw);

  const selected = bundle.scopes.filter((scope) =>
    matchesSelection(scopeOfPortableScope(scope), scope.viewportId, options.selection),
  );
  if (selected.length === 0) {
    throw invalid("The bundle has no scope matching the selected project, route and viewport.");
  }

  const results: ImportedScopeResult[] = [];
  let added = 0;
  let alreadyPresent = 0;

  for (const portable of selected) {
    const scope = scopeOfPortableScope(portable);
    let scopeAdded = 0;
    let scopePresent = 0;
    let activeVersionId: string | null = null;

    for (const version of portable.versions) {
      const absolute = resolveBundlePath(root, version.file, version.id);
      const png = await readFile(absolute).catch((cause: NodeJS.ErrnoException) => {
        throw invalid(`The bundle is missing ${version.file}: ${cause.message}`, cause);
      });
      verifyImageIntegrity(
        png,
        { sha256: version.sha256, bytes: version.bytes, width: version.width, height: version.height },
        `${version.id} in the bundle`,
      );

      const result = await importBaselineVersion({
        scope,
        viewportId: portable.viewportId,
        versionId: version.id,
        png,
        expectedSha256: version.sha256,
        approvedAt: version.approvedAt,
        sourceReportId: version.sourceReportId,
        capturedRoute: version.capturedRoute,
        note: version.note,
        routeName: portable.routeName,
        origin: portable.origin,
        targetLabel: portable.targetLabel,
        cwd: options.cwd,
        // Only the bundle's own active version is made active, and only when asked for.
        activate: options.activate && version.id === (portable.activeVersionId ?? portable.versions.at(-1)!.id),
      });
      if (result.outcome === "added") {
        scopeAdded += 1;
        added += 1;
      } else {
        scopePresent += 1;
        alreadyPresent += 1;
      }
      activeVersionId = result.activeVersionId;
    }

    results.push({
      scope,
      viewportId: portable.viewportId,
      added: scopeAdded,
      alreadyPresent: scopePresent,
      activeVersionId,
      activeMismatch: portable.activeVersionId !== null && portable.activeVersionId !== activeVersionId,
    });
  }

  return { scopes: results, added, alreadyPresent };
}

/** Where the store keeps its baselines — used for messages and for `--all` discovery. */
export function storeBaselinesDirectory(cwd?: string): string {
  return resolveBaselinesDir(cwd);
}
