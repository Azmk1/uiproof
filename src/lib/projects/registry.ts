import { isLoopbackHost } from "@/lib/http/trusted-request";
import type { ComparisonMode, ProjectRoute, RegisteredProject } from "@/lib/compare/types";

/**
 * Registered applications, read from a local configuration file.
 *
 * A registration is a promise about where UIProof may point a browser: this module is
 * what turns free-form JSON into a value the engine can trust. It is deliberately pure —
 * no filesystem, no Node APIs — so every rule below is unit tested directly, and the
 * file reading lives in `config.ts`.
 *
 * What a registration may contain:
 *  · `origin` is an `http(s)` URL on a **loopback** host, with no credentials, path,
 *    query or fragment. UIProof will not capture a public site in this phase.
 *  · `routes` is an explicit allow-list. A route the file does not name does not exist
 *    as far as the API is concerned — the browser is never handed an arbitrary URL.
 *  · `allowedOrigins` (optional) lists extra origins the *page* may load resources from
 *    while capturing. Empty by default, so a capture is hermetic unless a developer
 *    deliberately widens it.
 */

export const MAX_PROJECTS = 50;
export const MAX_ROUTES_PER_PROJECT = 50;
export const MAX_ALLOWED_ORIGINS = 10;
export const MAX_ROUTE_PATH_LENGTH = 200;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENCODED_TRAVERSAL = /%2e|%2f|%5c/i;

/** Modes a registered project route can run in: no fixture pair exists for it. */
export const PROJECT_MODES: readonly ComparisonMode[] = ["capture", "baseline"];
export const PROJECT_DEFAULT_MODE: ComparisonMode = "capture";

export function isValidProjectId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Route ids follow the same shape, so one pattern documents both. */
export function isValidRouteId(value: unknown): value is string {
  return isValidProjectId(value);
}

/**
 * A capturable path. Absolute (`/…`), never protocol-relative, no traversal — literal or
 * percent-encoded — no query string, fragment, whitespace or control characters.
 */
export function isValidRoutePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_ROUTE_PATH_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  if (value.includes("//") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  if (ENCODED_TRAVERSAL.test(value)) return false;
  if (value.includes("?") || value.includes("#") || value.includes(":")) return false;
  if (/\s/.test(value)) return false;
  // Rejecting control characters -- including the ones `\s` does not cover -- is the point.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * Normalises an origin string to `http://host:port`. Returns `null` unless it is an
 * http(s) URL on a loopback host with no credentials, path, query or fragment.
 */
export function parseLoopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!isLoopbackHost(parsed.host)) return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

/** Extra origins a page may load from. Any http(s) origin, but never a wildcard. */
function parseAllowedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (value.includes("*")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value.trim() : null;
}

function parseRoute(input: unknown, projectId: string, index: number): ProjectRoute {
  const where = `project "${projectId}" route #${index + 1}`;
  if (input === null || typeof input !== "object") throw new RangeError(`${where} must be an object.`);
  const source = input as Record<string, unknown>;

  const id = readString(source, "id");
  if (!isValidRouteId(id)) {
    throw new RangeError(`${where} needs an id of lowercase letters, digits and dashes (max 40).`);
  }
  const name = readString(source, "name");
  if (!name || name.length > 60) throw new RangeError(`${where} ("${id}") needs a name of 1–60 characters.`);

  const path = source.path;
  if (!isValidRoutePath(path)) {
    throw new RangeError(
      `${where} ("${id}") needs a path starting with "/", with no traversal, query, fragment or host.`,
    );
  }
  return { id, name, path, url: "" };
}

function parseProject(input: unknown, index: number): RegisteredProject {
  const where = `project #${index + 1}`;
  if (input === null || typeof input !== "object") throw new RangeError(`${where} must be an object.`);
  const source = input as Record<string, unknown>;

  const id = readString(source, "id");
  if (!isValidProjectId(id)) {
    throw new RangeError(`${where} needs an id of lowercase letters, digits and dashes (max 40).`);
  }
  const name = readString(source, "name");
  if (!name || name.length > 60) throw new RangeError(`project "${id}" needs a name of 1–60 characters.`);

  const origin = parseLoopbackOrigin(source.origin);
  if (!origin) {
    throw new RangeError(
      `project "${id}" needs an "origin" such as http://127.0.0.1:4173 — http(s), loopback host, no path, query or credentials.`,
    );
  }

  const rawRoutes = source.routes;
  if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
    throw new RangeError(`project "${id}" needs a non-empty "routes" array.`);
  }
  if (rawRoutes.length > MAX_ROUTES_PER_PROJECT) {
    throw new RangeError(`project "${id}" declares ${rawRoutes.length} routes; the limit is ${MAX_ROUTES_PER_PROJECT}.`);
  }
  const routes = rawRoutes.map((route, routeIndex) => parseRoute(route, id, routeIndex));
  const routeIds = new Set<string>();
  for (const route of routes) {
    if (routeIds.has(route.id)) throw new RangeError(`project "${id}" declares route "${route.id}" twice.`);
    routeIds.add(route.id);
  }
  const routePaths = new Set<string>();
  for (const route of routes) {
    if (routePaths.has(route.path)) throw new RangeError(`project "${id}" declares path "${route.path}" twice.`);
    routePaths.add(route.path);
  }

  const rawAllowed = source.allowedOrigins;
  let allowedOrigins: readonly string[] = [];
  if (rawAllowed !== undefined && rawAllowed !== null) {
    if (!Array.isArray(rawAllowed)) throw new RangeError(`project "${id}" has an "allowedOrigins" that is not an array.`);
    if (rawAllowed.length > MAX_ALLOWED_ORIGINS) {
      throw new RangeError(`project "${id}" lists ${rawAllowed.length} allowed origins; the limit is ${MAX_ALLOWED_ORIGINS}.`);
    }
    const parsed = rawAllowed.map(parseAllowedOrigin);
    if (parsed.some((entry) => entry === null)) {
      throw new RangeError(
        `project "${id}" lists an allowed origin that is not a plain http(s) origin (no wildcards, paths or credentials).`,
      );
    }
    allowedOrigins = [...new Set(parsed as string[])].filter((entry) => entry !== origin);
  }

  // Phase 7: an explicitly registered source directory the diagnosis may read. Parsed as
  // a plain path here (this module is pure); resolved and confined where it is opened.
  const rawSource = source.sourceDir;
  let sourceDir: string | null = null;
  if (rawSource !== undefined && rawSource !== null) {
    if (
      typeof rawSource !== "string" ||
      rawSource.trim().length === 0 ||
      rawSource.length > 300 ||
      /[\u0000-\u001f\u007f]/.test(rawSource)
    ) {
      throw new RangeError(`project "${id}" has a "sourceDir" that is not a usable path (1–300 characters, no control characters).`);
    }
    sourceDir = rawSource.trim();
  }

  return {
    id,
    name,
    origin,
    routes: routes.map((route) => ({ ...route, url: `${origin}${route.path}` })),
    modes: PROJECT_MODES,
    defaultMode: PROJECT_DEFAULT_MODE,
    allowedOrigins,
    sourceDir,
  };
}

export interface ParsedProjectConfig {
  readonly projects: readonly RegisteredProject[];
  /** Message naming the first problem found; `null` when the file is usable. */
  readonly error: string | null;
}

/**
 * Parses the configuration file. A malformed entry fails the whole file with a message
 * that names the entry: half a registry silently applied is worse than none.
 */
export function parseProjectConfig(raw: string): ParsedProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { projects: [], error: `The project configuration is not valid JSON: ${(cause as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { projects: [], error: "The project configuration must be a JSON object with a \"projects\" array." };
  }
  const source = parsed as Record<string, unknown>;
  if (!Array.isArray(source.projects)) {
    return { projects: [], error: "The project configuration must contain a \"projects\" array (it may be empty)." };
  }
  if (source.projects.length > MAX_PROJECTS) {
    return { projects: [], error: `The project configuration declares more than ${MAX_PROJECTS} projects.` };
  }

  const projects: RegisteredProject[] = [];
  const seen = new Set<string>();
  try {
    for (const [index, entry] of source.projects.entries()) {
      const project = parseProject(entry, index);
      if (seen.has(project.id)) {
        throw new RangeError(`project id "${project.id}" is declared twice.`);
      }
      seen.add(project.id);
      projects.push(project);
    }
  } catch (cause) {
    return { projects: [], error: cause instanceof Error ? cause.message : String(cause) };
  }

  return { projects, error: null };
}

export function findProject(projects: readonly RegisteredProject[], id: unknown): RegisteredProject | undefined {
  if (typeof id !== "string") return undefined;
  return projects.find((project) => project.id === id);
}

export function findRoute(project: RegisteredProject, routeId: unknown): ProjectRoute | undefined {
  if (typeof routeId !== "string") return undefined;
  return project.routes.find((route) => route.id === routeId);
}

/**
 * Builds the capture URL for a registered route and proves it stayed on the project's
 * own origin. Every registered path is re-validated here, so a value that somehow
 * reached the engine without going through the parser still cannot escape.
 */
export function buildProjectCaptureUrl(project: RegisteredProject, route: ProjectRoute): URL {
  if (!isValidRoutePath(route.path)) {
    throw new RangeError(`Refusing to capture unapproved route path: ${String(route.path)}`);
  }
  const base = new URL(project.origin);
  const url = new URL(route.path, base);
  if (url.origin !== base.origin) {
    throw new RangeError(`Capture URL escaped the registered origin: ${url.toString()}`);
  }
  if (url.pathname !== route.path || url.search !== "" || url.hash !== "") {
    throw new RangeError(`Capture URL was altered by URL parsing: ${url.toString()} from ${route.path}`);
  }
  return url;
}

/** Scope key for a registered route: `project:<projectId>/<routeId>`. */
export function projectScopeKey(projectId: string, routeId: string): string {
  return `project:${projectId}/${routeId}`;
}
