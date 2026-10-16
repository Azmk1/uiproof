import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LockTimeoutError, withFileLock } from "./file-lock";

/**
 * The lock is exercised against a real directory in the system temp folder: real
 * `mkdir` races, real owner files, real takeovers. Two processes are covered by the
 * browser suite (`e2e/baseline-concurrency.test.ts`), which runs two servers against one
 * data directory; these tests cover the semantics that must hold inside one process.
 */

const ROOT = path.join(os.tmpdir(), `uiproof-lock-${randomUUID()}`);

function lockPath(name: string): string {
  return path.join(ROOT, `${name}.lock`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("serialises overlapping critical sections instead of interleaving them", async () => {
    const lock = lockPath("serialise");
    const events: string[] = [];

    const task = (name: string, holdMs: number) => async () => {
      events.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      events.push(`${name}:exit`);
      return name;
    };

    const results = await Promise.all([
      withFileLock(lock, task("a", 40)),
      withFileLock(lock, task("b", 10)),
      withFileLock(lock, task("c", 10)),
    ]);

    // Which task wins the race is not part of the contract; mutual exclusion is.
    expect(new Set(results)).toEqual(new Set(["a", "b", "c"]));
    expect(events).toHaveLength(6);
    for (let index = 0; index < events.length; index += 2) {
      const name = events[index].replace(":enter", "");
      expect(events[index]).toBe(`${name}:enter`);
      expect(events[index + 1], `section ${name} was interleaved with another`).toBe(`${name}:exit`);
    }
  });

  it("writes an owner file naming this process while the lock is held", async () => {
    const lock = lockPath("owner");
    await withFileLock(lock, async () => {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as {
        pid: number;
        host: string;
      };
      expect(owner.pid).toBe(process.pid);
      expect(owner.host).toBe(os.hostname());
    });
    expect(await exists(lock)).toBe(false);
  });

  it("releases the lock when the task throws", async () => {
    const lock = lockPath("throws");
    await expect(
      withFileLock(lock, async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    expect(await exists(lock)).toBe(false);
    // And the lock is usable straight afterwards.
    await expect(withFileLock(lock, async () => "ok")).resolves.toBe("ok");
  });

  it("takes over a lock whose owner is gone, once it is old enough", async () => {
    const lock = lockPath("stale");
    await mkdir(lock, { recursive: true });
    // A pid that cannot be running: above the Linux pid ceilings, invalid on Windows.
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, host: os.hostname() }), "utf8");

    const value = await withFileLock(lock, async () => "took over", { staleMs: 0, timeoutMs: 2_000 });
    expect(value).toBe("took over");
    expect(await exists(lock)).toBe(false);
  });

  it("refuses to steal from a live owner and fails with a typed timeout", async () => {
    const lock = lockPath("live");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;

    const holder = withFileLock(lock, async () => {
      entered = true;
      await held;
      return "holder";
    });

    while (!entered) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The owner is this very process, which is alive: the lock must not be stolen even
    // though it is "old" by the staleness threshold.
    await expect(withFileLock(lock, async () => "thief", { staleMs: 0, timeoutMs: 150 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    release();
    await expect(holder).resolves.toBe("holder");
    expect(await exists(lock)).toBe(false);
  });

  it("reports the lock directory in its timeout message", async () => {
    const lock = lockPath("message");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const holder = withFileLock(lock, async () => {
      entered = true;
      await held;
    });

    // Wait until the first holder really owns the lock, so the second call has to wait.
    while (!entered) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(withFileLock(lock, async () => undefined, { timeoutMs: 100 })).rejects.toThrow(/message\.lock/);
    release();
    await holder;
  });
});
