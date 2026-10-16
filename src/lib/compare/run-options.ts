import { ComparisonError } from "./errors";
import { getTarget, resolveCurrentRoute, targetSupportsMode } from "./targets";
import {
  buildProjectCaptureUrl,
  findProject,
  findRoute,
  projectScopeKey,
} from "@/lib/projects/registry";
import type {
  BaselineScope,
  ComparisonMode,
  ComparisonTarget,
  ProjectRoute,
  RegisteredProject,
  RunSourceKind,
} from "./types";

/**
 * Parsing and validation for the options a caller may send with a run.
 *
 * The body arrives as `unknown` from JSON, so nothing here trusts its shape. Since Phase
 * 3 there are two kinds of source: a demo target from the compiled catalogue, or a route
 * of an application the developer registered in the local configuration file. A project
 * id that is not in the file does not exist; a route that is not in that project does not
 * exist — so a request can never point the browser at a URL the file did not name.
 */

export const DEFAULT_MODE: ComparisonMode = "fixture";
export const COMPARISON_MODES: readonly ComparisonMode[] = ["fixture", "baseline", "capture"];

export function isComparisonMode(value: unknown): value is ComparisonMode {
  return typeof value === "string" && (COMPARISON_MODES as readonly string[]).includes(value);
}

/** Absent means `fixture`, which keeps Phase 1 callers working unchanged. */
export function parseComparisonMode(input: unknown): ComparisonMode {
  if (input === undefined || input === null) return DEFAULT_MODE;
  if (!isComparisonMode(input)) {
    throw new RangeError(`mode must be one of: ${COMPARISON_MODES.join(", ")}`);
  }
  return input;
}

/** Absent means "the target's default page state". */
export function parseVariantId(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || input.length === 0 || input.length > 40) {
    throw new RangeError("variantId must be a short string");
  }
  return input;
}

/**
 * Where a run captures from, once the request has been resolved against the catalogue
 * and the project configuration. Everything downstream reads this and trusts it.
 */
export interface ResolvedRunSource {
  readonly kind: RunSourceKind;
  /** `demo:<targetId>` or `project:<projectId>/<routeId>`. */
  readonly scopeKey: string;
  readonly label: string;
  /** Demo target behind this source, when there is one. */
  readonly target: ComparisonTarget | null;
  readonly project: RegisteredProject | null;
  readonly route: ProjectRoute | null;
  /** Origin the capture happens on. */
  readonly origin: string;
  /** Route that is captured. */
  readonly path: string;
  /** Reference fixture route for `fixture` mode; null for project sources. */
  readonly fixtureBaselinePath: string | null;
  readonly modes: readonly ComparisonMode[];
  readonly defaultMode: ComparisonMode;
  readonly allowedOrigins: readonly string[];
}

export interface RunSourceRequestLike {
  readonly kind?: unknown;
  readonly targetId?: unknown;
  readonly projectId?: unknown;
  readonly routeId?: unknown;
}

export function parseRunSourceRequest(input: unknown): RunSourceRequestLike {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ComparisonError("invalid_options", "source must be an object.");
  }
  return input as RunSourceRequestLike;
}

function demoSource(route: unknown, uiProofOrigin: string): ResolvedRunSource {
  if (typeof route !== "string") {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${String(route)}`);
  }
  const target = getTarget(route);
  if (!target) {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${route}`);
  }
  return {
    kind: "demo",
    scopeKey: `demo:${target.id}`,
    label: target.label,
    target,
    project: null,
    route: null,
    origin: uiProofOrigin,
    path: target.current.path,
    fixtureBaselinePath: target.baseline.path,
    modes: target.modes,
    defaultMode: target.defaultMode,
    allowedOrigins: [],
  };
}

function projectSource(
  request: RunSourceRequestLike,
  projects: readonly RegisteredProject[],
  configError: string | null,
): ResolvedRunSource {
  if (configError) {
    throw new ComparisonError(
      "project_config_invalid",
      `The project configuration could not be read, so no project can be captured: ${configError}`,
    );
  }
  const project = findProject(projects, request.projectId);
  if (!project) {
    throw new ComparisonError(
      "project_not_registered",
      `Project ${JSON.stringify(String(request.projectId))} is not registered in the UIProof project configuration.`,
    );
  }
  const route = findRoute(project, request.routeId);
  if (!route) {
    throw new ComparisonError(
      "route_not_registered",
      `Route ${JSON.stringify(String(request.routeId))} is not registered for project "${project.id}".`,
    );
  }
  // Proves the URL still points at the registered origin, even for a tampered record.
  buildProjectCaptureUrl(project, route);

  return {
    kind: "project",
    scopeKey: projectScopeKey(project.id, route.id),
    label: `${project.name} · ${route.name}`,
    target: null,
    project,
    route,
    origin: project.origin,
    path: route.path,
    fixtureBaselinePath: null,
    modes: project.modes,
    defaultMode: project.defaultMode,
    allowedOrigins: project.allowedOrigins,
  };
}

export interface ResolveRunSourceInput {
  /** Phase 3 spelling: `{ kind, projectId, routeId }` or `{ kind: "demo", targetId }`. */
  readonly source?: unknown;
  /** Phase 1/2 spelling of a demo target id. */
  readonly targetId?: unknown;
  readonly projects: readonly RegisteredProject[];
  readonly projectConfigError?: string | null;
  /** Origin of this UIProof instance — where the demo fixtures live. */
  readonly uiProofOrigin: string;
}

/**
 * Resolves one run request to a source. `source` wins when present; otherwise the body
 * is read as a Phase 1/2 demo request (`targetId`).
 */
export function resolveRunSource(input: ResolveRunSourceInput): ResolvedRunSource {
  const request = parseRunSourceRequest(input.source);
  const kind = request.kind ?? (request.projectId !== undefined ? "project" : "demo");

  if (kind === "project") {
    return projectSource(request, input.projects, input.projectConfigError ?? null);
  }
  if (kind !== "demo") {
    throw new ComparisonError("invalid_options", `source.kind must be "demo" or "project", got ${JSON.stringify(kind)}.`);
  }

  const targetId = request.targetId ?? input.targetId;
  return demoSource(targetId, input.uiProofOrigin);
}

export interface ResolveRunInput extends ResolveRunSourceInput {
  readonly mode: unknown;
  readonly variantId: unknown;
}

export interface ResolvedRun {
  readonly source: ResolvedRunSource;
  readonly mode: ComparisonMode;
  readonly variantId: string | null;
  readonly currentRoute: string;
}

/**
 * Resolves source + mode + page state together, because they constrain each other: a
 * project has no fixture pair to compare against, and only demo targets declare page
 * states. Every rejection is a typed 400 naming the problem.
 */
export function resolveRun(input: ResolveRunInput): ResolvedRun {
  const source = resolveRunSource(input);

  let mode: ComparisonMode;
  try {
    // An absent mode means "whatever this source does by default": the fixture pair for a
    // demo target (unchanged since Phase 1), a plain capture for a project route, which
    // has no reference image until someone approves one.
    mode =
      input.mode === undefined || input.mode === null
        ? source.defaultMode
        : parseComparisonMode(input.mode);
  } catch (cause) {
    throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
  }

  if (!source.modes.includes(mode)) {
    throw new ComparisonError(
      "mode_unavailable",
      `${source.label} does not support ${mode} ${mode === "fixture" ? "comparison" : "runs"}. Available: ${source.modes.join(", ")}.`,
    );
  }

  let variantId: string | null = null;
  let currentRoute = source.path;
  if (source.kind === "demo" && source.target) {
    let requestedVariant: string | null;
    try {
      requestedVariant = parseVariantId(input.variantId);
    } catch (cause) {
      throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
    }
    try {
      currentRoute = resolveCurrentRoute(source.target, requestedVariant);
    } catch (cause) {
      throw new ComparisonError("invalid_options", (cause as Error).message, { cause });
    }
    const variants = source.target.variants ?? [];
    variantId = variants.length === 0 ? null : (requestedVariant ?? source.target.defaultVariantId ?? null);
  } else if (input.variantId !== undefined && input.variantId !== null) {
    throw new ComparisonError(
      "invalid_options",
      `${source.label} has no page states; variantId is only meaningful for demo fixtures.`,
    );
  }

  return { source, mode, variantId, currentRoute };
}

/** Which stored baseline a run of this source compares against. */
export function baselineScopeOf(source: ResolvedRunSource): BaselineScope {
  if (source.kind === "project") {
    if (!source.project || !source.route) {
      throw new ComparisonError("project_not_registered", "Project source is missing its project or route.");
    }
    return { kind: "project", projectId: source.project.id, routeId: source.route.id };
  }
  if (!source.target) {
    throw new ComparisonError("invalid_target", "Demo source is missing its target.");
  }
  return { kind: "demo", targetId: source.target.id };
}

export function requireTarget(id: unknown): ComparisonTarget {
  if (typeof id !== "string") {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${String(id)}`);
  }
  const target = getTarget(id);
  if (!target) {
    throw new ComparisonError("invalid_target", `Unknown comparison target: ${id}`);
  }
  return target;
}

export { targetSupportsMode };
