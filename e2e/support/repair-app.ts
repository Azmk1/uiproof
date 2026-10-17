import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pickFreePort } from "./example-app";

/**
 * A disposable copy of the Phase 8 fixture application.
 *
 * Each test gets its own directory, so a test can swap a view (the visual-regression
 * scenario does exactly that) without one scenario leaking into another. The directory the
 * repair engine copies as its source is this copy — never anything in the repository.
 */

const SOURCE_DIR = path.join(process.cwd(), "examples", "repair-app");
const READY_TIMEOUT_MS = 20_000;

export interface RepairApp {
  readonly url: string;
  readonly port: number;
  readonly dir: string;
  /** Replaces `views/index.html` with one of the fixture's variants. */
  readonly useView: (variant: "index" | "visual.good" | "visual.broken") => Promise<void>;
  readonly readView: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

async function waitForHealth(url: string, child: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The repair fixture exited with ${child.exitCode} before it was ready\n${log.join("")}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The repair fixture did not answer /healthz within ${READY_TIMEOUT_MS}ms\n${log.join("")}`);
}

export async function startRepairApp(): Promise<RepairApp> {
  const port = await pickFreePort([4181, 4182, 4183, 4184, 4185, 4186, 4187, 4188]);
  const dir = path.join(os.tmpdir(), `uiproof-repair-app-${randomUUID()}`);
  await cp(SOURCE_DIR, dir, { recursive: true });

  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    cwd: dir,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), EXAMPLE_APP_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, child, log);
  } catch (error) {
    child.kill();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    port,
    dir,
    useView: async (variant) => {
      const source = path.join(dir, "views", variant === "index" ? "index.html" : `${variant}.html`);
      const target = path.join(dir, "views", "index.html");
      await writeFile(target, await readFile(source, "utf8"), "utf8");
    },
    readView: () => readFile(path.join(dir, "views", "index.html"), "utf8"),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
