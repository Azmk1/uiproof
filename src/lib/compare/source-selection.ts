/**
 * What the console is pointed at: a demo fixture target, or one route of an
 * application registered in the local configuration file.
 *
 * The console is a client component, so it derives its selection from the catalogue the
 * server sent rather than from anything it invents. This module is pure and React-free —
 * it can be unit tested directly, and every value it produces (a scope key, a request
 * body, an API path) is one the server also validates, so a stale console cannot widen
 * what may be captured.
 */
import type {
  CatalogResponse,
  ComparisonMode,
  ComparisonTarget,
  ProjectRoute,
  RegisteredProject,
} from "./types";

export type SourceSelection =
  | { readonly kind: "demo"; readonly targetId: string }
  | { readonly kind: "project"; readonly projectId: string; readonly routeId: string };

/** A selection resolved against the catalogue into everything a run needs. */
export interface SelectedSource {
  readonly kind: "demo" | "project";
  readonly selection: SourceSelection;
  /** `demo:<targetId>` or `project:<projectId>/<routeId>` — the key baselines use. */
  readonly scopeKey: string;
  readonly label: string;
  /** Origin the page is captured from; `null` for a demo target, served by UIProof. */
  readonly origin: string | null;
  readonly path: string;
  readonly modes: readonly ComparisonMode[];
  readonly defaultMode: ComparisonMode;
  readonly target: ComparisonTarget | null;
  readonly project: RegisteredProject | null;
  readonly route: ProjectRoute | null;
}

/** An option as the picker renders it, grouped by where it comes from. */
export interface SourceOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

export interface SourceGroup {
  readonly key: string;
  readonly label: string;
  readonly note: string | null;
  readonly options: readonly SourceOption[];
}

export const PROJECT_BASELINES_SEGMENT = "projects";

export function demoSelection(targetId: string): SourceSelection {
  return { kind: "demo", targetId };
}

export function projectSelection(projectId: string, routeId: string): SourceSelection {
  return { kind: "project", projectId, routeId };
}

/** Stability of this string is what keeps selection state and React keys honest. */
export function sourceScopeKey(selection: SourceSelection): string {
  return selection.kind === "demo"
    ? `demo:${selection.targetId}`
    : `project:${selection.projectId}/${selection.routeId}`;
}

/** The value a radio option carries: the scope key, which parses back to a selection. */
export function sourceId(selection: SourceSelection): string {
  return sourceScopeKey(selection);
}

export function parseSourceId(value: unknown): SourceSelection | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("demo:")) {
    const targetId = value.slice("demo:".length);
    return targetId.length > 0 ? demoSelection(targetId) : null;
  }
  if (value.startsWith("project:")) {
    const rest = value.slice("project:".length);
    const separator = rest.indexOf("/");
    if (separator < 1 || separator === rest.length - 1) return null;
    return projectSelection(rest.slice(0, separator), rest.slice(separator + 1));
  }
  return null;
}

/** The request body's `source` field, in the shape the API validates. */
export function sourceRequest(
  selection: SourceSelection,
): { readonly kind: "demo"; readonly targetId: string } | { readonly kind: "project"; readonly projectId: string; readonly routeId: string } {
  return selection.kind === "demo"
    ? { kind: "demo", targetId: selection.targetId }
    : { kind: "project", projectId: selection.projectId, routeId: selection.routeId };
}

/**
 * Resolves a selection against the catalogue. Returns `null` when the catalogue no longer
 * contains it — a project removed from the configuration file, say — so the console can
 * fall back to a valid default instead of requesting something that cannot be captured.
 */
export function resolveSource(
  catalog: Pick<CatalogResponse, "targets" | "projects">,
  selection: SourceSelection,
): SelectedSource | null {
  if (selection.kind === "demo") {
    const target = catalog.targets.find((item) => item.id === selection.targetId);
    if (!target) return null;
    return {
      kind: "demo",
      selection,
      scopeKey: sourceScopeKey(selection),
      label: target.label,
      origin: null,
      path: target.current.path,
      modes: target.modes,
      defaultMode: target.defaultMode,
      target,
      project: null,
      route: null,
    };
  }

  const project = catalog.projects.find((item) => item.id === selection.projectId);
  const route = project?.routes.find((item) => item.id === selection.routeId);
  if (!project || !route) return null;
  return {
    kind: "project",
    selection,
    scopeKey: sourceScopeKey(selection),
    label: `${project.name} · ${route.name}`,
    origin: project.origin,
    path: route.path,
    modes: project.modes,
    defaultMode: project.defaultMode,
    target: null,
    project,
    route,
  };
}

/** What the console selects on first load: the shipped demo fixture, as in Phase 1. */
export function defaultSelection(catalog: Pick<CatalogResponse, "targets" | "projects">): SourceSelection | null {
  const firstTarget = catalog.targets[0];
  if (firstTarget) return demoSelection(firstTarget.id);
  const firstProject = catalog.projects[0];
  const firstRoute = firstProject?.routes[0];
  if (firstProject && firstRoute) return projectSelection(firstProject.id, firstRoute.id);
  return null;
}

/**
 * The picker's contents. Demo fixtures and registered projects are separate groups so a
 * developer can always tell which of their own applications a route belongs to, and an
 * empty registry is still rendered — with the reason — rather than hidden.
 */
export function sourceGroups(catalog: Pick<CatalogResponse, "targets" | "projects">): readonly SourceGroup[] {
  const groups: SourceGroup[] = [];
  if (catalog.targets.length > 0) {
    groups.push({
      key: "demo",
      label: "Demo fixtures",
      note: "Shipped pages that prove the engine end to end.",
      options: catalog.targets.map((target) => ({
        id: sourceId(demoSelection(target.id)),
        label: target.label,
        hint: `${target.baseline.path} → ${target.current.path}`,
      })),
    });
  }
  for (const project of catalog.projects) {
    groups.push({
      key: sourceId(projectSelection(project.id, project.routes[0]?.id ?? "")),
      label: project.name,
      note: `${project.origin} · ${project.routes.length} registered route${project.routes.length === 1 ? "" : "s"}`,
      options: project.routes.map((route) => ({
        id: sourceId(projectSelection(project.id, route.id)),
        label: route.name,
        hint: route.path,
      })),
    });
  }
  return groups;
}

/**
 * Application-relative path of a baseline endpoint for this scope. Mirrors
 * `baselineImageUrl` in `baseline-paths.ts`: demo baselines keep their Phase 2 path and
 * project baselines live under the `projects` namespace.
 */
export function baselineApiPath(selection: SourceSelection, viewportId: string): string {
  const viewport = encodeURIComponent(viewportId);
  if (selection.kind === "demo") {
    return `/api/baselines/${encodeURIComponent(selection.targetId)}/${viewport}`;
  }
  return `/api/baselines/${PROJECT_BASELINES_SEGMENT}/${encodeURIComponent(selection.projectId)}/${encodeURIComponent(
    selection.routeId,
  )}/${viewport}`;
}

/** The mode to show after switching source: keep the current one when it still applies. */
export function modeForSource(source: SelectedSource, preferred: ComparisonMode): ComparisonMode {
  return source.modes.includes(preferred) ? preferred : source.defaultMode;
}
