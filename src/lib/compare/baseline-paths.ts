/**
 * Path-level rules for the baseline store. Like `storage-paths.ts` this module makes
 * no filesystem calls, so every guard can be unit tested directly.
 *
 * Layout:
 *   <data>/baselines/<targetId>/<viewportId>/manifest.json
 *   <data>/baselines/<targetId>/<viewportId>/versions/<versionId>.png
 *
 * Both directory segments come from the target/viewport catalogue, never from free
 * text, and the version id must match the id this codebase generates.
 */
import path from "node:path";
import { resolveDataDir } from "./storage-paths";
import { getTarget, getViewport } from "./targets";

export const BASELINE_MANIFEST_FILENAME = "manifest.json";
export const BASELINE_VERSIONS_DIRNAME = "versions";
export const BASELINE_VERSION_PREFIX = "bl-";

const VERSION_ID = /^bl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_FILE = /^bl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

export function resolveBaselinesDir(cwd?: string): string {
  return path.join(resolveDataDir(cwd), "baselines");
}

export function isValidBaselineVersionId(id: unknown): id is string {
  return typeof id === "string" && VERSION_ID.test(id);
}

export function isValidBaselineVersionFileName(name: unknown): name is string {
  return typeof name === "string" && VERSION_FILE.test(name);
}

export function versionFileName(versionId: string): string {
  if (!isValidBaselineVersionId(versionId)) {
    throw new RangeError(`Invalid baseline version id: ${String(versionId)}`);
  }
  return `${versionId}.png`;
}

function assertInside(parent: string, candidate: string): string {
  const resolvedParent = path.resolve(parent);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedParent && !resolved.startsWith(resolvedParent + path.sep)) {
    throw new RangeError(`Refusing to access a path outside the data directory: ${candidate}`);
  }
  return resolved;
}

/**
 * Directory holding one target/viewport baseline. The identifiers are validated
 * against the catalogue, so an unknown or hostile target id can never become a path.
 */
export function resolveBaselineDir(targetId: unknown, viewportId: unknown, cwd?: string): string {
  if (!getTarget(targetId)) {
    throw new RangeError(`Unknown comparison target: ${String(targetId)}`);
  }
  if (!getViewport(viewportId)) {
    throw new RangeError(`Unknown viewport preset: ${String(viewportId)}`);
  }
  const baselinesDir = resolveBaselinesDir(cwd);
  return assertInside(baselinesDir, path.join(baselinesDir, targetId as string, viewportId as string));
}

export function resolveBaselineManifestPath(targetId: unknown, viewportId: unknown, cwd?: string): string {
  return assertInside(
    resolveBaselineDir(targetId, viewportId, cwd),
    path.join(resolveBaselineDir(targetId, viewportId, cwd), BASELINE_MANIFEST_FILENAME),
  );
}

export function resolveBaselineVersionPath(
  targetId: unknown,
  viewportId: unknown,
  versionId: unknown,
  cwd?: string,
): string {
  if (!isValidBaselineVersionId(versionId)) {
    throw new RangeError(`Invalid baseline version id: ${String(versionId)}`);
  }
  const dir = resolveBaselineDir(targetId, viewportId, cwd);
  return assertInside(dir, path.join(dir, BASELINE_VERSIONS_DIRNAME, versionFileName(versionId)));
}

/** Application-relative URL the console loads a baseline image from. */
export function baselineImageUrl(targetId: string, viewportId: string, versionId: string): string {
  return `/api/baselines/${encodeURIComponent(targetId)}/${encodeURIComponent(viewportId)}/${encodeURIComponent(
    versionFileName(versionId),
  )}`;
}
