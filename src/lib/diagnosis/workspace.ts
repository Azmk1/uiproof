import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";

/**
 * The one place UIProof reads application source, and the rules that make it safe.
 *
 * A developer registers a directory explicitly — in `uiproof.config.json` or with
 * `--source` — and this module is the only thing that touches it. Everything below is
 * deliberately narrow:
 *
 *  · **Read-only.** The module has no write path at all: no `writeFile`, no `mkdir`, no
 *    `rm`. What it exposes is a listing and a `read`.
 *  · **Inside the root, or refused.** Every read re-resolves the path and proves it is
 *    still inside the canonical root, so a symlink or a `..` that appeared after the walk
 *    cannot escape it.
 *  · **No secrets by construction.** Dot-files and dot-directories are skipped wholesale,
 *    which covers `.env`, `.env.local`, `.git`, `.npmrc` and friends without needing a
 *    list of every secret filename in existence; key material, lockfiles and logs are
 *    skipped by name as well.
 *  · **No dependencies or build output.** `node_modules`, `dist`, `.next`, `build`, `out`,
 *    `coverage` and minified bundles are skipped: they are not the developer's code, and
 *    they would swamp the investigation.
 *  · **Bounded.** Depth, file count and per-file size are all capped, so pointing UIProof
 *    at a huge tree cannot turn into an unbounded read.
 *
 * Skipped paths are counted by reason and reported — the same rule the rest of this
 * codebase follows for anything it could not read.
 */

export const MAX_FILES = 4000;
export const MAX_DEPTH = 12;
export const MAX_FILE_BYTES = 256 * 1024;

/** Extensions worth investigating. Anything else is skipped by extension. */
const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".astro",
]);

/** Directories that never contain the code under review. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".uiproof",
  "__pycache__",
]);

/** File names (or suffixes) that may hold credentials, logs or generated output. */
const SKIPPED_FILE_PATTERNS: readonly RegExp[] = [
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i,
  /\.(log|lock|map|min\.js|min\.css|tsbuildinfo|snap)$/i,
  /(^|[-_.])secret(s)?([-_.]|$)/i,
  /(^|[-_.])credentials?([-_.]|$)/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(env|npmrc|netrc|htpasswd)/i,
];

export interface WorkspaceFile {
  /** Path relative to the root, always with `/` separators so it is stable on Windows. */
  readonly relativePath: string;
  /** Absolute path inside the root. Never shown to a model. */
  readonly absolutePath: string;
  readonly bytes: number;
  readonly lines: number;
}

export interface SkippedPath {
  readonly path: string;
  readonly reason: string;
}

export interface Workspace {
  /** Canonical (symlink-resolved) absolute root. */
  readonly root: string;
  readonly files: readonly WorkspaceFile[];
  /** Bounded sample of what was not read, so the caller can report it honestly. */
  readonly skipped: readonly SkippedPath[];
  readonly skippedCounts: Readonly<Record<string, number>>;
  /** Reads one file, re-proving that it is still inside the root. */
  readonly read: (file: WorkspaceFile) => Promise<string>;
}

const MAX_SKIPPED_REPORTED = 40;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function inside(parent: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === parent || resolved.startsWith(parent + path.sep);
}

/** True when a path segment is hidden. Hidden things are never read. */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function skipReasonForFile(name: string): string | null {
  if (isHidden(name)) return "hidden file (dot-files are never read)";
  const lower = name.toLowerCase();
  for (const pattern of SKIPPED_FILE_PATTERNS) {
    if (pattern.test(lower)) return "looks like a credential, log or generated file";
  }
  const extension = path.extname(name).toLowerCase();
  if (extension.length === 0) return "no file extension";
  if (!ALLOWED_EXTENSIONS.has(extension)) return `extension ${extension} is outside the investigated set`;
  return null;
}

/**
 * Opens a directory as a source workspace. Throws `diagnosis_source_invalid` when the
 * path is missing, is not a directory, or cannot be canonicalised.
 */
export async function openWorkspace(rootInput: unknown, cwd: string = process.cwd()): Promise<Workspace> {
  if (typeof rootInput !== "string" || rootInput.trim().length === 0) {
    throw new ComparisonError("diagnosis_source_invalid", "A source directory is required to investigate application code.");
  }
  const requested = path.resolve(cwd, rootInput.trim());
  let canonical: string;
  try {
    const info = await stat(requested);
    if (!info.isDirectory()) {
      throw new ComparisonError("diagnosis_source_invalid", `The source path is not a directory: ${requested}`);
    }
    canonical = await realpath(requested);
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    throw new ComparisonError(
      "diagnosis_source_invalid",
      `The source directory could not be read: ${requested} (${(cause as Error).message})`,
      { cause },
    );
  }

  const files: WorkspaceFile[] = [];
  const skipped: SkippedPath[] = [];
  const skippedCounts: Record<string, number> = {};

  const skip = (relative: string, reason: string): void => {
    skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push({ path: relative, reason });
  };

  let truncated = false;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      skip(toPosix(path.relative(canonical, directory)) || ".", `could not be listed: ${(cause as Error).message}`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      const relative = toPosix(path.relative(canonical, full));

      if (entry.isSymbolicLink()) {
        skip(relative, "symbolic link (never followed)");
        continue;
      }
      if (entry.isDirectory()) {
        if (isHidden(entry.name) || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          skip(relative, "generated, dependency or hidden directory");
          continue;
        }
        if (depth + 1 > MAX_DEPTH) {
          skip(relative, `deeper than ${MAX_DEPTH} levels`);
          continue;
        }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skip(relative, "not a regular file");
        continue;
      }

      const reason = skipReasonForFile(entry.name);
      if (reason) {
        skip(relative, reason);
        continue;
      }

      let info;
      try {
        info = await lstat(full);
      } catch (cause) {
        skip(relative, `could not be inspected: ${(cause as Error).message}`);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        skip(relative, `larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB`);
        continue;
      }

      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch (cause) {
        skip(relative, `could not be read: ${(cause as Error).message}`);
        continue;
      }
      files.push({
        relativePath: relative,
        absolutePath: full,
        bytes: info.size,
        lines: text.length === 0 ? 1 : text.split("\n").length,
      });
    }
  };

  await walk(canonical, 0);
  if (truncated) skip(".", `stopped after ${MAX_FILES} files`);

  const byPath = new Map(files.map((file) => [file.relativePath, file] as const));

  const read = async (file: WorkspaceFile): Promise<string> => {
    const known = byPath.get(file.relativePath);
    if (!known) {
      throw new ComparisonError(
        "diagnosis_source_invalid",
        `Refusing to read a file that was not listed in the workspace: ${file.relativePath}`,
      );
    }
    // Re-resolve every time: the listing is a snapshot, and the file may have been
    // replaced by a symlink since. The canonical root is the only authority.
    let resolved: string;
    try {
      resolved = await realpath(known.absolutePath);
    } catch (cause) {
      throw new ComparisonError(
        "diagnosis_source_invalid",
        `The file could no longer be read: ${file.relativePath}`,
        { cause },
      );
    }
    if (!inside(canonical, resolved)) {
      throw new ComparisonError(
        "diagnosis_source_invalid",
        `Refusing to read outside the registered source directory: ${file.relativePath}`,
      );
    }
    const info = await stat(resolved);
    if (info.size > MAX_FILE_BYTES) {
      throw new ComparisonError(
        "diagnosis_source_invalid",
        `Refusing to read a file larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB: ${file.relativePath}`,
      );
    }
    return readFile(resolved, "utf8");
  };

  return { root: canonical, files, skipped, skippedCounts, read };
}
