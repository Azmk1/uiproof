import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { ComparisonError } from "@/lib/compare/errors";
import type { SourceRevision } from "./types";
import { openWorkspace, type Workspace } from "@/lib/diagnosis/workspace";

/**
 * Pins a repair to a source revision, and proves the original never moved.
 *
 * Two independent measurements:
 *
 *  · **Git.** `rev-parse HEAD` and `status --porcelain`, read with `execFile` and no shell,
 *    with a timeout and a bounded output. A directory that is not a Git repository is not
 *    an error — the fields are `null` and the record says so.
 *  · **A content digest.** SHA-256 over the sorted `<path>\0<sha256(file)>` lines of every
 *    file the workspace lists. This is what "pinned" actually means here: the sandbox was
 *    copied from these exact bytes, and a second digest after the run proves the originals
 *    are still those bytes.
 *
 * Both are recorded per run, so a repair can be reproduced and a stale one can be spotted.
 */

const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT = 512 * 1024;
const MAX_LISTED_DIRTY = 50;

/** A digest is refused rather than approximated when the tree is too large to prove. */
export const MAX_DIGEST_BYTES = 48 * 1024 * 1024;

const execFileAsync = promisify(execFile);

interface GitOutput {
  readonly stdout: string;
  readonly ok: boolean;
  readonly error: string | null;
}

async function git(cwd: string, args: readonly string[]): Promise<GitOutput> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: String(stdout), ok: true, error: null };
  } catch (cause) {
    const error = cause as { message?: string; code?: string | number };
    return {
      stdout: "",
      ok: false,
      error: error.code === "ENOENT" ? "git is not installed or not on PATH" : (error.message ?? "git failed"),
    };
  }
}

export interface GitRevision {
  readonly commitSha: string | null;
  readonly dirty: boolean | null;
  readonly dirtyFiles: readonly string[];
  /** Why Git could not be read, when it could not. */
  readonly reason: string | null;
}

/** Reads the Git state of the source directory. Never throws for a non-repository. */
export async function readGitRevision(sourceRoot: string): Promise<GitRevision> {
  const head = await git(sourceRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return {
      commitSha: null,
      dirty: null,
      dirtyFiles: [],
      reason: `Git could not be read in ${sourceRoot}: ${head.error ?? "no repository"}`,
    };
  }
  const status = await git(sourceRoot, ["status", "--porcelain", "--", "."]);
  if (!status.ok) {
    return {
      commitSha: head.stdout.trim() || null,
      dirty: null,
      dirtyFiles: [],
      reason: `The working tree could not be inspected: ${status.error ?? "git status failed"}`,
    };
  }
  const lines = status.stdout.split("\n").filter((line) => line.trim().length > 0);
  return {
    commitSha: head.stdout.trim() || null,
    dirty: lines.length > 0,
    dirtyFiles: lines.slice(0, MAX_LISTED_DIRTY).map((line) => line.slice(3).trim()),
    reason: null,
  };
}

export interface SourceDigest {
  /** SHA-256 over the sorted `<path>\0<sha256>` lines. */
  readonly digest: string;
  /** Per-file hashes, relative path → hex digest. */
  readonly files: ReadonlyMap<string, string>;
  readonly bytes: number;
}

/** Hashes contents the caller already holds, without another read of the directory. */
export function digestFileMap(contents: ReadonlyMap<string, string>): SourceDigest {
  const hashes = new Map<string, string>();
  let bytes = 0;
  for (const [relativePath, text] of contents) {
    bytes += Buffer.byteLength(text, "utf8");
    hashes.set(relativePath, createHash("sha256").update(text).digest("hex"));
  }
  return { digest: digestOf(hashes), files: hashes, bytes };
}

function digestOf(hashes: ReadonlyMap<string, string>): string {
  return createHash("sha256")
    .update(
      [...hashes.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([path, hash]) => `${path}\u0000${hash}`)
        .join("\n"),
    )
    .digest("hex");
}

/**
 * Hashes every file the workspace lists. Refuses a tree larger than `MAX_DIGEST_BYTES`,
 * because a repair that cannot prove what it pinned is not a repair UIProof can verify.
 */
export async function digestWorkspace(workspace: Workspace): Promise<SourceDigest> {
  let total = 0;
  const hashes = new Map<string, string>();
  for (const file of workspace.files) {
    total += file.bytes;
    if (total > MAX_DIGEST_BYTES) {
      throw new ComparisonError(
        "repair_limits_exceeded",
        `The source directory is larger than ${Math.round(MAX_DIGEST_BYTES / 1024 / 1024)} MB of listed files, ` +
          "so UIProof cannot pin and verify a revision of it.",
      );
    }
    const text = await workspace.read(file);
    hashes.set(file.relativePath, createHash("sha256").update(text).digest("hex"));
  }
  return { digest: digestOf(hashes), files: hashes, bytes: total };
}

/**
 * The pinned revision of one source directory: Git state plus a content digest.
 * `workspace` is optional so the digest can be reused when the caller already has it.
 */
export async function captureRevision(sourceRoot: string, workspace: Workspace): Promise<SourceRevision> {
  const [gitState, digest] = await Promise.all([readGitRevision(sourceRoot), digestWorkspace(workspace)]);
  return {
    commitSha: gitState.commitSha,
    dirty: gitState.dirty,
    dirtyFiles: gitState.dirtyFiles,
    capturedAt: new Date().toISOString(),
    sourceRoot,
    digest: digest.digest,
    digestFiles: digest.files.size,
  };
}

/**
 * Re-hashes the original directory and compares it with the digest captured before the
 * sandbox was made. Used to prove the run did not alter the developer's tree.
 */
export async function digestAfter(sourceRoot: string): Promise<{ digest: string; files: number } | null> {
  try {
    const workspace = await openWorkspace(sourceRoot);
    const digest = await digestWorkspace(workspace);
    return { digest: digest.digest, files: digest.files.size };
  } catch {
    return null;
  }
}

export interface StaleSourceResult {
  readonly checked: number;
  readonly stale: readonly string[];
  readonly missing: readonly string[];
  readonly reason: string | null;
}

/**
 * Compares a stored snapshot of `<path, sha256>` against the directory as it is now.
 * A missing directory is reported as everything stale, with the reason, rather than
 * silently claiming the references still hold.
 */
export async function detectStaleSources(
  sourceRoot: string,
  snapshot: Readonly<Record<string, string>>,
): Promise<StaleSourceResult> {
  const entries = Object.entries(snapshot);
  if (entries.length === 0) return { checked: 0, stale: [], missing: [], reason: null };

  let workspace: Workspace;
  try {
    workspace = await openWorkspace(sourceRoot);
  } catch (cause) {
    return {
      checked: entries.length,
      stale: entries.map(([path]) => path),
      missing: [],
      reason: `The registered source directory is no longer readable: ${(cause as Error).message}`,
    };
  }

  const byPath = new Map(workspace.files.map((file) => [file.relativePath, file] as const));
  const stale: string[] = [];
  const missing: string[] = [];

  for (const [relativePath, expected] of entries) {
    const file = byPath.get(relativePath);
    if (!file) {
      missing.push(relativePath);
      continue;
    }
    try {
      const text = await workspace.read(file);
      const actual = createHash("sha256").update(text).digest("hex");
      if (actual !== expected) stale.push(relativePath);
    } catch {
      missing.push(relativePath);
    }
  }

  return { checked: entries.length, stale, missing, reason: null };
}
