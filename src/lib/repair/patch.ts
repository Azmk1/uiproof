import { ComparisonError } from "@/lib/compare/errors";
import type { PatchFileSummary, ScopeCheck, ScopeViolation } from "./types";

/**
 * A strict, dependency-free unified-diff reader.
 *
 * The model is asked for a patch; this module is the only thing that decides whether that
 * patch is allowed to touch anything. Three separate guarantees, all enforced here rather
 * than trusted to a caller:
 *
 *  · **No shell.** Nothing is applied with `git apply` or any other command. The hunks are
 *    matched against file contents that UIProof copied from the registered directory, in
 *    memory, with exact context matching. A patch either describes the bytes we have or it
 *    is refused.
 *  · **No escape.** Every path is normalised and must be a relative path inside the source
 *    root that the workspace listed. `..`, absolute paths, drive letters, backslashes,
 *    symlinks and files outside the root cannot appear in an accepted patch.
 *  · **No scope creep.** Secrets, dependencies, lockfiles, generated output, Git metadata,
 *    CI policy, the registration file itself and approved baselines are refused by name.
 *    Size, file count and line count are capped, so "narrowly scoped" is a measured
 *    property rather than a request in a prompt.
 *
 * Everything below is pure: the same patch text and the same file map always produce the
 * same result or the same refusal.
 */

export const MAX_PATCH_FILES = 4;
export const MAX_PATCH_LINES = 200;
export const MAX_PATCH_CHARS = 48_000;
export const MAX_HUNKS_PER_FILE = 20;

export interface PatchLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly PatchLine[];
}

export interface ParsedPatchFile {
  /** Path relative to the source root, with `/` separators. */
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
}

export interface ParsedPatch {
  readonly files: readonly ParsedPatchFile[];
  readonly additions: number;
  readonly deletions: number;
  readonly text: string;
}

export interface PatchLimits {
  readonly maxFiles: number;
  readonly maxLines: number;
  readonly maxChars: number;
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxFiles: MAX_PATCH_FILES,
  maxLines: MAX_PATCH_LINES,
  maxChars: MAX_PATCH_CHARS,
};

function refuse(message: string): never {
  throw new ComparisonError("repair_patch_rejected", `The proposed patch was refused: ${message}`);
}

/**
 * Files a repair may never modify, whatever the prompt or the model says. Each rule names
 * the reason a reviewer will read, because "rejected" without a reason is not evidence.
 */
const FORBIDDEN_PATHS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /(^|\/)\./, reason: "hidden path (Git metadata, environment files and dotfiles are never patched)" },
  { pattern: /(^|\/)(node_modules|bower_components|vendor)\//, reason: "dependency directory" },
  { pattern: /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache)\//, reason: "generated output" },
  { pattern: /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i, reason: "key material" },
  {
    pattern: /(^|\/)(secret|secrets|credentials?)([-_.]|$)/i,
    reason: "a file whose name marks it as a credential",
  },
  {
    pattern:
      /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?|requirements\.txt|Pipfile(\.lock)?|poetry\.lock|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|Cargo\.(toml|lock))$/,
    reason: "dependency manifest or lockfile",
  },
  {
    pattern:
      /(^|\/)(tsconfig[^/]*\.json|next\.config\.\w+|vite\.config\.\w+|vitest[^/]*\.config\.\w+|webpack\.config\.\w+|rollup\.config\.\w+|turbo\.json|eslint\.config\.\w+|\.eslintrc[^/]*)$/,
    reason: "build or lint configuration",
  },
  { pattern: /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i, reason: "container/build configuration" },
  {
    pattern: /(^|\/)(\.github\/|\.gitlab-ci\.ya?ml$|\.circleci\/|azure-pipelines\.ya?ml$|Jenkinsfile$)/,
    reason: "CI policy",
  },
  { pattern: /(^|\/)uiproof\.config\.json$/, reason: "the UIProof registration file itself" },
  { pattern: /(^|\/)(uiproof-baselines|\.uiproof)\//, reason: "an approved-baseline store" },
  { pattern: /(^|\/)__snapshots__\//, reason: "a generated test snapshot" },
  { pattern: /\.(snap|map|min\.js|min\.css|lock|lockb)$/i, reason: "generated or minified file" },
];

/** Source extensions a repair may edit. Anything else is not application code. */
const EDITABLE_EXTENSIONS = new Set([
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

/** A single glob matcher: `**` crosses directories, `*` and `?` stay inside one segment. */
export function matchesGlob(pattern: string, candidate: string): boolean {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex).test(candidate);
}

function normalisePath(raw: string, side: "---" | "+++"): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const tabIndex = value.indexOf("\t");
  if (tabIndex !== -1) value = value.slice(0, tabIndex);
  value = value.trim();

  if (value === "/dev/null") {
    refuse(`${side} creates or deletes a whole file, which a repair may not do`);
  }
  if (value.includes("\\")) refuse(`${side} names a path with a backslash: ${JSON.stringify(value)}`);
  if (value.startsWith("/")) refuse(`${side} names an absolute path: ${JSON.stringify(value)}`);
  if (/^[A-Za-z]:/.test(value)) refuse(`${side} names a drive-qualified path: ${JSON.stringify(value)}`);
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  if (value.length === 0) refuse(`${side} names an empty path`);

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      refuse(`${side} names a path with an empty, current or parent segment: ${JSON.stringify(value)}`);
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) refuse(`${side} names a path with a control character`);
  }
  return segments.join("/");
}

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) refuse(`a hunk header is malformed: ${JSON.stringify(line.slice(0, 80))}`);
  const oldStart = Number.parseInt(match[1], 10);
  const newStart = Number.parseInt(match[3], 10);
  const oldLines = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newLines = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  if (oldLines < 0 || newLines < 0) refuse("a hunk header declares a negative line count");
  if (oldStart < 0 || newStart < 0) refuse("a hunk header declares a negative starting line");
  return { oldStart, oldLines, newStart, newLines };
}

/**
 * Parses a unified diff. Refuses anything it does not fully understand: a patch that is
 * partly read and partly guessed at is worse than one that is rejected.
 */
export function parsePatch(text: string): ParsedPatch {
  if (typeof text !== "string" || text.trim().length === 0) refuse("the patch was empty");
  if (text.length > MAX_PATCH_CHARS) {
    throw new ComparisonError(
      "repair_limits_exceeded",
      `The proposed patch is ${text.length} characters; the limit is ${MAX_PATCH_CHARS}.`,
    );
  }

  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedPatchFile[] = [];
  let additions = 0;
  let deletions = 0;
  let index = 0;

  const isFileHeader = (line: string): boolean => line.startsWith("--- ") && rawLines[index + 1]?.startsWith("+++ ") === true;

  while (index < rawLines.length) {
    const line = rawLines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (line.startsWith("diff --git")) {
      index += 1;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode")) {
      index += 1;
      continue;
    }
    if (!isFileHeader(line)) {
      refuse(`line ${index + 1} is not a file header: ${JSON.stringify(line.slice(0, 80))}`);
    }

    const oldPath = normalisePath(line.slice("--- ".length), "---");
    const newPath = normalisePath(rawLines[index + 1].slice("+++ ".length), "+++");
    if (oldPath !== newPath) refuse(`a hunk renames ${oldPath} to ${newPath}; renames are not accepted`);
    index += 2;

    const hunks: PatchHunk[] = [];
    while (index < rawLines.length && !isFileHeader(rawLines[index]) && !rawLines[index].startsWith("diff --git")) {
      const headerLine = rawLines[index];
      if (headerLine.trim().length === 0) {
        index += 1;
        continue;
      }
      if (!headerLine.startsWith("@@")) {
        refuse(`expected a hunk header after ${oldPath}, found ${JSON.stringify(headerLine.slice(0, 80))}`);
      }
      const header = parseHunkHeader(headerLine);
      index += 1;

      const lines: PatchLine[] = [];
      while (index < rawLines.length) {
        const current = rawLines[index];
        if (current.startsWith("@@") || current.startsWith("diff --git") || isFileHeader(current)) break;
        if (current.startsWith("\\")) {
          // "No newline at end of file": accepted and ignored. UIProof keeps the file's
          // existing trailing-newline state rather than rewriting it.
          index += 1;
          continue;
        }
        if (current.startsWith("+")) {
          lines.push({ kind: "add", text: current.slice(1) });
          additions += 1;
        } else if (current.startsWith("-")) {
          lines.push({ kind: "remove", text: current.slice(1) });
          deletions += 1;
        } else if (current.startsWith(" ")) {
          lines.push({ kind: "context", text: current.slice(1) });
        } else if (current.length === 0) {
          // Some models emit an empty line where the diff needs a single space. Treating
          // it as an empty context line is the only unambiguous reading.
          lines.push({ kind: "context", text: "" });
        } else {
          refuse(`a hunk line starts with ${JSON.stringify(current.slice(0, 1))}: ${JSON.stringify(current.slice(0, 80))}`);
        }
        index += 1;
      }

      const oldCount = lines.filter((entry) => entry.kind !== "add").length;
      const newCount = lines.filter((entry) => entry.kind !== "remove").length;
      if (oldCount !== header.oldLines) {
        refuse(
          `a hunk in ${oldPath} declares ${header.oldLines} old line(s) but contains ${oldCount}`,
        );
      }
      if (newCount !== header.newLines) {
        refuse(
          `a hunk in ${oldPath} declares ${header.newLines} new line(s) but contains ${newCount}`,
        );
      }
      if (lines.length === 0) refuse(`a hunk in ${oldPath} is empty`);
      hunks.push({ ...header, lines });
      if (hunks.length > MAX_HUNKS_PER_FILE) refuse(`${oldPath} has more than ${MAX_HUNKS_PER_FILE} hunks`);
    }

    if (hunks.length === 0) refuse(`${oldPath} has no hunks`);
    if (files.some((entry) => entry.path === oldPath)) refuse(`${oldPath} appears twice in the patch`);
    files.push({ path: oldPath, hunks });
    if (files.length > MAX_PATCH_FILES) {
      throw new ComparisonError(
        "repair_limits_exceeded",
        `The proposed patch touches ${files.length} files; the limit is ${MAX_PATCH_FILES}.`,
      );
    }
  }

  if (files.length === 0) refuse("the patch contains no file changes");
  if (additions + deletions > MAX_PATCH_LINES) {
    throw new ComparisonError(
      "repair_limits_exceeded",
      `The proposed patch changes ${additions + deletions} lines; the limit is ${MAX_PATCH_LINES}.`,
    );
  }

  return { files, additions, deletions, text };
}

/**
 * Checks a parsed patch against the files the workspace listed and the scope policy.
 * A path that is not in `knownFiles` is refused whether or not it looks reasonable: the
 * workspace is what UIProof actually copied, and nothing else exists as far as a repair
 * is concerned.
 */
export function checkPatchScope(
  patch: ParsedPatch,
  knownFiles: readonly string[],
  allow: readonly string[] = ["**"],
): ScopeCheck {
  const known = new Set(knownFiles);
  const violations: ScopeViolation[] = [];
  const files: string[] = [];

  for (const entry of patch.files) {
    const path = entry.path;
    files.push(path);

    const forbidden = FORBIDDEN_PATHS.find((rule) => rule.pattern.test(path));
    if (forbidden) {
      violations.push({ path, reason: forbidden.reason });
      continue;
    }
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (!EDITABLE_EXTENSIONS.has(extension)) {
      violations.push({ path, reason: `extension ${extension || "(none)"} is not application source` });
      continue;
    }
    if (!known.has(path)) {
      violations.push({ path, reason: "the file is not part of the registered source directory" });
      continue;
    }
    if (!allow.some((pattern) => matchesGlob(pattern, path))) {
      violations.push({ path, reason: "the project's repair allow-list does not include this file" });
    }
  }

  return { ok: violations.length === 0, files, violations };
}

function splitFile(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function applyHunks(path: string, text: string, hunks: readonly PatchHunk[]): string {
  const { lines, trailingNewline } = splitFile(text);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? Math.min(hunk.oldStart, lines.length) : hunk.oldStart - 1;
    if (start < 0 || start > lines.length) {
      refuse(`${path}: a hunk starts at line ${hunk.oldStart}, which is outside the file (${lines.length} lines)`);
    }
    if (start < cursor) refuse(`${path}: hunks overlap at line ${hunk.oldStart}`);

    output.push(...lines.slice(cursor, start));
    let position = start;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      if (position >= lines.length) {
        refuse(`${path}: a hunk expects line ${position + 1}, which is past the end of the file`);
      }
      if (lines[position] !== line.text) {
        refuse(
          `${path}:${position + 1} does not match the patch's ${line.kind === "context" ? "context" : "removed"} line ` +
            `(file has ${JSON.stringify(lines[position].slice(0, 80))}, patch expects ${JSON.stringify(line.text.slice(0, 80))})`,
        );
      }
      if (line.kind === "context") output.push(lines[position]);
      position += 1;
    }
    cursor = position;
  }

  output.push(...lines.slice(cursor));
  return output.join("\n") + (trailingNewline && output.length > 0 ? "\n" : "");
}

export interface AppliedPatch {
  /** The complete file map after the patch: unchanged entries included. */
  readonly files: Map<string, string>;
  readonly changes: readonly PatchFileSummary[];
}

/**
 * Applies a parsed patch to a file map. Throws `repair_patch_rejected` on any mismatch —
 * there is no fuzz factor, because a hunk that does not match the bytes UIProof copied is
 * a change nobody can reason about.
 */
export function applyPatch(
  patch: ParsedPatch,
  files: ReadonlyMap<string, string>,
): AppliedPatch {
  const next = new Map(files);
  const changes: PatchFileSummary[] = [];

  for (const entry of patch.files) {
    const original = files.get(entry.path);
    if (original === undefined) {
      refuse(`${entry.path} is not one of the files UIProof copied from the source directory`);
    }
    const patched = applyHunks(entry.path, original, entry.hunks);
    if (patched === original) {
      refuse(`${entry.path} would not change; the patch is a no-op`);
    }
    next.set(entry.path, patched);
    changes.push({
      path: entry.path,
      additions: entry.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length, 0),
      deletions: entry.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length, 0),
    });
  }

  return { files: next, changes };
}

/** Parses, scopes and applies in one step, in that order. */
export function preparePatch(input: {
  readonly patch: string;
  readonly files: ReadonlyMap<string, string>;
  readonly knownFiles: readonly string[];
  readonly allow?: readonly string[];
  readonly limits?: Partial<PatchLimits>;
}): { parsed: ParsedPatch; applied: AppliedPatch; scope: ScopeCheck } {
  const limits = { ...DEFAULT_PATCH_LIMITS, ...input.limits };
  const parsed = parsePatch(input.patch);
  if (parsed.files.length > limits.maxFiles) {
    throw new ComparisonError(
      "repair_limits_exceeded",
      `The proposed patch touches ${parsed.files.length} files; the limit is ${limits.maxFiles}.`,
    );
  }
  if (parsed.additions + parsed.deletions > limits.maxLines) {
    throw new ComparisonError(
      "repair_limits_exceeded",
      `The proposed patch changes ${parsed.additions + parsed.deletions} lines; the limit is ${limits.maxLines}.`,
    );
  }
  const scope = checkPatchScope(parsed, input.knownFiles, input.allow);
  if (!scope.ok) {
    const detail = scope.violations.map((violation) => `${violation.path} (${violation.reason})`).join("; ");
    throw new ComparisonError(
      "repair_scope_violation",
      `The proposed patch would modify files a repair may not touch: ${detail}`,
    );
  }
  const applied = applyPatch(parsed, input.files);
  return { parsed, applied, scope };
}
