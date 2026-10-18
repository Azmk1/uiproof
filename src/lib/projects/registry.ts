import { isLoopbackHost } from "@/lib/http/trusted-request";
import type { ComparisonMode, ProjectRoute, RegisteredProject } from "@/lib/compare/types";
import type { RepairExecutionConfig, RepairProjectConfig, RepairSandboxConfig } from "@/lib/repair/types";

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
export const MAX_REPAIR_COMMAND_ARGS = 20;
export const MAX_REPAIR_ARG_LENGTH = 300;
export const MAX_REPAIR_ENV = 10;

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

/**
 * One shell-free command line for a repair sandbox. Tokens are passed to `execFile` as an
 * argument vector, so a metacharacter is a literal — but it is far more likely to be a
 * mistaken attempt at a shell pipeline, so it is refused with an explanation instead.
 */
function parseRepairCommand(input: unknown, where: string): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RangeError(`${where} must be a non-empty array of command arguments.`);
  }
  if (input.length > MAX_REPAIR_COMMAND_ARGS) {
    throw new RangeError(`${where} has ${input.length} arguments; the limit is ${MAX_REPAIR_COMMAND_ARGS}.`);
  }
  return input.map((token, index) => {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new RangeError(`${where}[${index}] must be a non-empty string.`);
    }
    if (token.length > MAX_REPAIR_ARG_LENGTH) {
      throw new RangeError(`${where}[${index}] is longer than ${MAX_REPAIR_ARG_LENGTH} characters.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(token)) {
      throw new RangeError(`${where}[${index}] contains a control character.`);
    }
    if (/[;&|`$<>]/.test(token)) {
      throw new RangeError(
        `${where}[${index}] contains a shell metacharacter; repair commands run without a shell, so pass separate arguments instead.`,
      );
    }
    if (token.split(/[\\/]/).includes("..")) {
      throw new RangeError(`${where}[${index}] contains a parent-directory segment, which the sandbox does not allow.`);
    }
    return token;
  });
}

const REPAIR_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

function parseSandbox(input: unknown, projectId: string): RepairSandboxConfig {
  const where = `project "${projectId}" repair.sandbox`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RangeError(`${where} must be an object with a command and a url.`);
  }
  const source = input as Record<string, unknown>;
  const command = parseRepairCommand(source.command, `${where}.command`);

  const url = parseLoopbackOrigin(source.url);
  if (!url) {
    throw new RangeError(
      `${where}.url must be a loopback http(s) origin such as http://127.0.0.1:4199 — no path, query, credentials or wildcard.`,
    );
  }

  const rawReady = source.readyPath;
  const readyPath = rawReady === undefined || rawReady === null ? "/healthz" : rawReady;
  if (!isValidRoutePath(readyPath)) {
    throw new RangeError(`${where}.readyPath must be a plain path such as /healthz.`);
  }

  const env: Record<string, string> = {};
  const rawEnv = source.env;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (rawEnv === null || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
      throw new RangeError(`${where}.env must be an object of string values.`);
    }
    const entries = Object.entries(rawEnv as Record<string, unknown>);
    if (entries.length > MAX_REPAIR_ENV) {
      throw new RangeError(`${where}.env has ${entries.length} entries; the limit is ${MAX_REPAIR_ENV}.`);
    }
    for (const [key, value] of entries) {
      if (!REPAIR_ENV_KEY.test(key)) throw new RangeError(`${where}.env has an invalid variable name: ${JSON.stringify(key)}.`);
      if (SECRET_ENV_KEY.test(key)) {
        throw new RangeError(
          `${where}.env.${key} looks like a credential. A repair sandbox never receives secrets; remove it.`,
        );
      }
      if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new RangeError(`${where}.env.${key} must be a string of at most 500 characters without control characters.`);
      }
      env[key] = value;
    }
  }

  return { command, url, readyPath, env };
}

const DOCKER_IMAGE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const USER_SPEC = /^[0-9]{1,7}(:[0-9]{1,7})?$/;
const REPAIR_MODES = ["container", "host"] as const;
const REPAIR_NETWORKS = ["none", "egress"] as const;
const REPAIR_RUNTIMES = ["auto", "docker", "podman"] as const;

/**
 * The `execution` block: where generated application code is allowed to run.
 *
 * The default is container execution, because the alternative — running a model's patch
 * with the developer's own privileges — is a decision only the developer can make, and they
 * have to make it in writing. A registration that asks for host execution without saying
 * `trustHostExecution: true` is refused with that sentence in the error, rather than
 * quietly doing it.
 */
function parseExecution(input: unknown, projectId: string): RepairExecutionConfig {
  const where = `project "${projectId}" repair.execution`;
  const defaults: RepairExecutionConfig = {
    mode: "container",
    runtime: "auto",
    image: null,
    network: "none",
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    user: null,
    dependenciesVolume: null,
    install: null,
    trustHostExecution: false,
  };
  // An absent block still becomes a complete configuration, and it goes through exactly the
  // same validation as a written one: "not configured" must not be the one state that skips
  // the requirement for an image.
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    throw new RangeError(`${where} must be an object.`);
  }
  const source = (input ?? {}) as Record<string, unknown>;

  const rawMode = source.mode;
  const mode = rawMode === undefined || rawMode === null ? defaults.mode : rawMode;
  if (typeof mode !== "string" || !(REPAIR_MODES as readonly string[]).includes(mode)) {
    throw new RangeError(`${where}.mode must be "container" or "host".`);
  }

  const rawRuntime = source.runtime;
  const runtime = rawRuntime === undefined || rawRuntime === null ? defaults.runtime : rawRuntime;
  if (typeof runtime !== "string" || !(REPAIR_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new RangeError(`${where}.runtime must be "auto", "docker" or "podman".`);
  }

  const rawNetwork = source.network;
  const network = rawNetwork === undefined || rawNetwork === null ? defaults.network : rawNetwork;
  if (typeof network !== "string" || !(REPAIR_NETWORKS as readonly string[]).includes(network)) {
    throw new RangeError(`${where}.network must be "none" or "egress".`);
  }

  const rawTrust = source.trustHostExecution;
  const trustHostExecution = rawTrust === undefined || rawTrust === null ? false : rawTrust;
  if (typeof trustHostExecution !== "boolean") {
    throw new RangeError(`${where}.trustHostExecution must be true or false.`);
  }

  let image: string | null = null;
  const rawImage = source.image;
  if (rawImage !== undefined && rawImage !== null) {
    if (typeof rawImage !== "string" || rawImage.length > 200 || !DOCKER_IMAGE.test(rawImage.trim())) {
      throw new RangeError(
        `${where}.image must be an image reference with an explicit tag, such as "node:24-bookworm-slim" — an untagged image can change under a run.`,
      );
    }
    image = rawImage.trim();
  }
  if (mode === "container" && image === null) {
    throw new RangeError(
      `${where}.image is required in container mode; it is the environment the patched application is built and measured in. Add one, or set ${where}.mode to "host" with "trustHostExecution": true.`,
    );
  }
  if (mode === "host" && image !== null) {
    throw new RangeError(`${where}.image is only used in container mode; remove it or set ${where}.mode to "container".`);
  }
  if (mode === "host" && trustHostExecution !== true) {
    throw new RangeError(
      `${where}.mode is "host", which runs generated code with your own privileges. Set "trustHostExecution": true to accept that, or use container mode.`,
    );
  }

  let user: string | null = null;
  const rawUser = source.user;
  if (rawUser !== undefined && rawUser !== null) {
    if (typeof rawUser !== "string" || !USER_SPEC.test(rawUser.trim())) {
      throw new RangeError(`${where}.user must be "uid" or "uid:gid" if it is set.`);
    }
    user = rawUser.trim();
  }

  let dependenciesVolume: string | null = null;
  const rawVolume = source.dependenciesVolume;
  if (rawVolume !== undefined && rawVolume !== null) {
    if (typeof rawVolume !== "string" || !VOLUME_NAME.test(rawVolume.trim())) {
      throw new RangeError(`${where}.dependenciesVolume must be a volume name (letters, digits, dot, dash, underscore).`);
    }
    dependenciesVolume = rawVolume.trim();
  }

  const install = source.install === undefined || source.install === null
    ? null
    : parseRepairCommand(source.install, `${where}.install`);
  if (install !== null && dependenciesVolume === null) {
    throw new RangeError(`${where}.install only makes sense with ${where}.dependenciesVolume, which names the volume it fills.`);
  }

  return {
    mode: mode as RepairExecutionConfig["mode"],
    runtime: runtime as RepairExecutionConfig["runtime"],
    image,
    network: network as RepairExecutionConfig["network"],
    memoryMb: readBoundedInt(source.memoryMb, defaults.memoryMb, 256, 32_768, `${where}.memoryMb`),
    cpus: readBoundedNumber(source.cpus, defaults.cpus, 0.5, 16, `${where}.cpus`),
    pidsLimit: readBoundedInt(source.pidsLimit, defaults.pidsLimit, 64, 8192, `${where}.pidsLimit`),
    user,
    dependenciesVolume,
    install,
    trustHostExecution,
  };
}

function readBoundedInt(value: unknown, fallback: number, min: number, max: number, where: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${where} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number, where: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${where} must be a number between ${min} and ${max}.`);
  }
  return value;
}

/**
 * The optional autonomous-repair block. It is validated as strictly as an origin: an
 * invalid sandbox fails the registration instead of being ignored, because a project that
 * asked for repair and silently got none is a worse outcome than an error.
 */
function parseRepair(input: unknown, projectId: string, routeIds: readonly string[]): RepairProjectConfig {
  const where = `project "${projectId}" repair`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RangeError(`${where} must be an object.`);
  }
  const source = input as Record<string, unknown>;
  const sandbox = parseSandbox(source.sandbox, projectId);

  const build = source.build === undefined || source.build === null ? null : parseRepairCommand(source.build, `${where}.build`);
  const test = source.test === undefined || source.test === null ? null : parseRepairCommand(source.test, `${where}.test`);

  let allow: string[] = ["**"];
  if (source.allow !== undefined && source.allow !== null) {
    if (!Array.isArray(source.allow) || source.allow.length === 0 || source.allow.length > 20) {
      throw new RangeError(`${where}.allow must be a non-empty array of at most 20 glob patterns.`);
    }
    allow = source.allow.map((pattern, index) => {
      if (typeof pattern !== "string" || pattern.trim().length === 0 || pattern.length > 200) {
        throw new RangeError(`${where}.allow[${index}] must be a non-empty pattern of at most 200 characters.`);
      }
      if (pattern.startsWith("/") || pattern.includes("..")) {
        throw new RangeError(`${where}.allow[${index}] must be relative to the source directory and may not contain "..".`);
      }
      return pattern.trim();
    });
  }

  let entryFiles: string[] = [];
  if (source.entryFiles !== undefined && source.entryFiles !== null) {
    if (!Array.isArray(source.entryFiles) || source.entryFiles.length > 4) {
      throw new RangeError(`${where}.entryFiles must be an array of at most 4 relative source paths.`);
    }
    entryFiles = source.entryFiles.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 200) {
        throw new RangeError(`${where}.entryFiles[${index}] must be a non-empty path of at most 200 characters.`);
      }
      const value = entry.trim();
      if (value.startsWith("/") || value.includes("..") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new RangeError(`${where}.entryFiles[${index}] must be a relative POSIX path inside the source directory.`);
      }
      return value;
    });
  }

  let guardRoutes: string[] = [];
  if (source.guardRoutes !== undefined && source.guardRoutes !== null) {
    if (!Array.isArray(source.guardRoutes) || source.guardRoutes.length > 4) {
      throw new RangeError(`${where}.guardRoutes must be an array of at most 4 registered route ids.`);
    }
    guardRoutes = source.guardRoutes.map((routeId, index) => {
      if (!isValidRouteId(routeId) || !routeIds.includes(routeId)) {
        throw new RangeError(`${where}.guardRoutes[${index}] is not a route id registered by this project.`);
      }
      return routeId;
    });
  }

  const execution = parseExecution(source.execution, projectId);

  return { sandbox, build, test, allow, guardRoutes, entryFiles, execution };
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

  // Phase 8: the optional isolated repair sandbox, build and test commands.
  const repair =
    source.repair === undefined || source.repair === null
      ? null
      : parseRepair(source.repair, id, routes.map((route) => route.id));

  return {
    id,
    name,
    origin,
    routes: routes.map((route) => ({ ...route, url: `${origin}${route.path}` })),
    modes: PROJECT_MODES,
    defaultMode: PROJECT_DEFAULT_MODE,
    allowedOrigins,
    sourceDir,
    repair,
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
