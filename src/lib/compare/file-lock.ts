import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A cooperative cross-process lock, built on the one filesystem operation that is
 * atomic everywhere: `mkdir` fails with `EEXIST` when the directory already exists.
 *
 * It exists because the Phase 2 manifest update was *not* a compare-and-swap across
 * processes — it re-read the file after writing and retried, which loses an update if
 * two UIProof processes (a dev server and a `next start`, or two test servers sharing a
 * data directory) approve at the same moment.
 *
 * Failure policy, deliberately conservative:
 *  · The owner writes `owner.json` with its pid as soon as it takes the lock.
 *  · If that pid is still alive on this machine, the lock is never stolen — the waiter
 *    gives up with a typed error instead of corrupting a live writer's manifest.
 *  · If the owner is gone (crash, `kill -9`, a pid from another host, an unreadable
 *    owner file) the lock is taken over once the directory is older than `staleMs`.
 *
 * This is not a distributed lock: it assumes one machine and a local filesystem. Both
 * are true for UIProof, which stores everything under `UIPROOF_DATA_DIR`.
 */

export interface FileLockOptions {
  /** How long to wait for the lock before failing. */
  readonly timeoutMs?: number;
  /** Age at which a lock whose owner is gone counts as abandoned. */
  readonly staleMs?: number;
  /** First retry delay; doubles up to `maxPollMs`. */
  readonly pollMs?: number;
  readonly maxPollMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 20_000;
const DEFAULT_POLL_MS = 10;
const DEFAULT_MAX_POLL_MS = 200;

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

const OWNER_FILENAME = "owner.json";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(path.join(lockDir, OWNER_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "",
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    };
  } catch {
    return null;
  }
}

/** True when the pid is running *on this machine*, which is the only case we can judge. */
function isOwnerAlive(owner: LockOwner | null): boolean {
  if (!owner) return false;
  if (owner.host !== "" && owner.host !== os.hostname()) return false;
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function ageMs(lockDir: string): Promise<number> {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Runs `task` while holding an exclusive lock on `lockDir`. Returns the task's value and
 * always releases the lock — including when the task throws.
 */
export async function withFileLock<T>(
  lockDir: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  await mkdir(path.dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = await readOwner(lockDir);
    if (isOwnerAlive(owner)) {
      // A live writer owns it. Never steal; wait and then fail honestly.
    } else if ((await ageMs(lockDir)) > staleMs) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new LockTimeoutError(
        `Timed out after ${timeoutMs}ms waiting for ${lockDir}. Another UIProof process is writing it.`,
      );
    }
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }

  try {
    const owner: LockOwner = { pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() };
    await writeFile(path.join(lockDir, OWNER_FILENAME), `${JSON.stringify(owner)}\n`, "utf8");
    return await task();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
