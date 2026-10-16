/**
 * Path-level rules for the baseline store. Like `storage-paths.ts` this module makes no
 * filesystem calls, so every guard can be unit tested directly.
 *
 * Layout, demo (unchanged since Phase 2 — existing data keeps working, no migration):
 *   <data>/baselines/<targetId>/<viewportId>/manifest.json
 *   <data>/baselines/<targetId>/<viewportId>/versions/<versionId>.png
 *
 * Layout, registered project:
 *   <data>/baselines/projects/<projectId>/<routeId>/<viewportId>/manifest.json
 *   <data>/baselines/projects/<projectId>/<routeId>/<viewportId>/versions/<versionId>.png
 *
 * The `projects` segment namespaces project baselines away from demo targets, so the two
 * can never share a directory. Every path segment is validated against the id shapes this
 * codebase generates — none of them is free text.
 */
import path from "node:path";
import { resolveDataDir } from "./storage-paths";
import { getTarget, getViewport } from "./targets";
import { isValidProjectId, isValidRouteId } from "@/lib/projects/registry";
import type { BaselineScope, RunSourceKind } from "./types";

export const BASELINE_MANIFEST_FILENAME = "manifest.json";
export const BASELINE_VERSIONS_DIRNAME = "versions";
export const BASELINE_VERSION_PREFIX = "bl-";
/** Reserved directory name: project baselines never collide with a demo target id. */
export const PROJECT_BASELINES_DIRNAME = "projects";
export const BASELINE_LOCK_DIRNAME = ".manifest.lock";

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

/** Validates a scope object. Returns the normalised scope. */
export function parseBaselineScope(value: unknown): BaselineScope {
  if (value === null || typeof value !== "object") {
    throw new RangeError("A baseline scope must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;

  if (kind === "demo") {
    if (!getTarget(candidate.targetId)) {
      throw new RangeError(`Unknown comparison target: ${String(candidate.targetId)}`);
    }
    return { kind: "demo", targetId: candidate.targetId as string };
  }

  if (kind === "project") {
    if (!isValidProjectId(candidate.projectId)) {
      throw new RangeError(`Invalid project id: ${String(candidate.projectId)}`);
    }
    if (!isValidRouteId(candidate.routeId)) {
      throw new RangeError(`Invalid route id: ${String(candidate.routeId)}`);
    }
    return { kind: "project", projectId: candidate.projectId, routeId: candidate.routeId };
  }

  throw new RangeError(`Unknown baseline scope kind: ${String(kind)}`);
}

/** `demo:<targetId>` or `project:<projectId>/<routeId>` — the same keys runs use. */
export function baselineScopeKey(scope: BaselineScope): string {
  return scope.kind === "demo" ? `demo:${scope.targetId}` : `project:${scope.projectId}/${scope.routeId}`;
}

/** Parses a scope key back into a scope, refusing anything malformed. */
export function parseBaselineScopeKey(key: unknown): BaselineScope {
  if (typeof key !== "string") throw new RangeError(`Invalid baseline scope key: ${String(key)}`);
  if (key.startsWith("demo:")) {
    return parseBaselineScope({ kind: "demo", targetId: key.slice("demo:".length) });
  }
  if (key.startsWith("project:")) {
    const rest = key.slice("project:".length);
    const separator = rest.indexOf("/");
    if (separator < 1) throw new RangeError(`Invalid baseline scope key: ${key}`);
    return parseBaselineScope({
      kind: "project",
      projectId: rest.slice(0, separator),
      routeId: rest.slice(separator + 1),
    });
  }
  throw new RangeError(`Invalid baseline scope key: ${key}`);
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
 * Directory holding one baseline. Demo scopes resolve to exactly the Phase 2 path, so
 * existing approved baselines are found where they already are.
 */
export function resolveBaselineDir(scope: unknown, viewportId: unknown, cwd?: string): string {
  const parsed = parseBaselineScope(scope);
  if (!getViewport(viewportId)) {
    throw new RangeError(`Unknown viewport preset: ${String(viewportId)}`);
  }
  const viewport = viewportId as string;
  const baselinesDir = resolveBaselinesDir(cwd);

  if (parsed.kind === "demo") {
    return assertInside(baselinesDir, path.join(baselinesDir, parsed.targetId, viewport));
  }

  const projectsDir = assertInside(baselinesDir, path.join(baselinesDir, PROJECT_BASELINES_DIRNAME));
  const projectDir = assertInside(projectsDir, path.join(projectsDir, parsed.projectId));
  const routeDir = assertInside(projectDir, path.join(projectDir, parsed.routeId));
  return assertInside(routeDir, path.join(routeDir, viewport));
}

export function resolveBaselineManifestPath(scope: unknown, viewportId: unknown, cwd?: string): string {
  const dir = resolveBaselineDir(scope, viewportId, cwd);
  return assertInside(dir, path.join(dir, BASELINE_MANIFEST_FILENAME));
}

/** Directory used as a cross-process lock while the manifest is rewritten. */
export function resolveBaselineLockPath(scope: unknown, viewportId: unknown, cwd?: string): string {
  const dir = resolveBaselineDir(scope, viewportId, cwd);
  return assertInside(dir, path.join(dir, BASELINE_LOCK_DIRNAME));
}

export function resolveBaselineVersionPath(
  scope: unknown,
  viewportId: unknown,
  versionId: unknown,
  cwd?: string,
): string {
  if (!isValidBaselineVersionId(versionId)) {
    throw new RangeError(`Invalid baseline version id: ${String(versionId)}`);
  }
  const dir = resolveBaselineDir(scope, viewportId, cwd);
  return assertInside(dir, path.join(dir, BASELINE_VERSIONS_DIRNAME, versionFileName(versionId)));
}

/** Application-relative URL the console loads a baseline image from. */
export function baselineImageUrl(scope: BaselineScope, viewportId: string, versionId: string): string {
  const file = encodeURIComponent(versionFileName(versionId));
  const viewport = encodeURIComponent(viewportId);
  if (scope.kind === "demo") {
    return `/api/baselines/${encodeURIComponent(scope.targetId)}/${viewport}/${file}`;
  }
  return `/api/baselines/${PROJECT_BASELINES_DIRNAME}/${encodeURIComponent(scope.projectId)}/${encodeURIComponent(
    scope.routeId,
  )}/${viewport}/${file}`;
}

/** Which scope a manifest wrote itself as; Phase 2 manifests were all demos. */
export function scopeKindOfManifest(value: { readonly scope?: unknown }): RunSourceKind {
  return value.scope === "project" ? "project" : "demo";
}
