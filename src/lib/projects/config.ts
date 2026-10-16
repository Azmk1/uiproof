import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseProjectConfig } from "./registry";
import type { ProjectCatalog } from "@/lib/compare/types";

/**
 * Reads the local project configuration file.
 *
 * Path resolution: `UIPROOF_PROJECTS_FILE` when set, otherwise `uiproof.config.json` in
 * the working directory. A missing file is a normal state — the console says so and the
 * demo fixtures keep working.
 *
 * The file is re-read whenever its size or modification time changes, so editing a
 * registration does not need a server restart. Reading is done per request and cached
 * on that pair of numbers only: no watcher, no long-lived handle.
 */

export const DEFAULT_PROJECTS_FILENAME = "uiproof.config.json";

interface CacheEntry {
  readonly key: string;
  readonly catalog: ProjectCatalog;
}

let cache: CacheEntry | null = null;

export function resolveProjectConfigPath(cwd: string = process.cwd()): string {
  const override = process.env.UIPROOF_PROJECTS_FILE;
  if (override && override.trim().length > 0) return path.resolve(cwd, override.trim());
  return path.join(cwd, DEFAULT_PROJECTS_FILENAME);
}

async function readCatalogFile(configPath: string): Promise<ProjectCatalog> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseProjectConfig(raw);
    if (parsed.error) {
      return { configPath, projects: [], error: parsed.error };
    }
    return { configPath, projects: parsed.projects, error: null };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return { configPath: null, projects: [], error: null };
    }
    return {
      configPath,
      projects: [],
      error: `The project configuration could not be read: ${(cause as Error).message}`,
    };
  }
}

/** Cached read of the project registry. */
export async function loadProjectCatalog(cwd?: string): Promise<ProjectCatalog> {
  const configPath = resolveProjectConfigPath(cwd);
  let key = "missing";
  try {
    // The registration file lives wherever the developer put it, which is outside the
    // build. The ignore comment tells Turbopack's tracer not to bundle the whole project
    // because of this one call; it changes nothing about the runtime behaviour.
    const info = await stat(/* turbopackIgnore: true */ configPath);
    key = `${info.size}:${info.mtimeMs}`;
  } catch {
    key = "missing";
  }

  if (cache && cache.key === `${configPath}|${key}`) return cache.catalog;

  const catalog = await readCatalogFile(configPath);
  cache = { key: `${configPath}|${key}`, catalog };
  return catalog;
}

/** Drops the cache. Used by tests that rewrite the configuration file. */
export function resetProjectCatalogCache(): void {
  cache = null;
}
