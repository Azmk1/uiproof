import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The browser suite drives a real production server over HTTP.
 *
 * It runs `next start` (not `next dev`) so the pages under test are the ones a user
 * would actually get, and against a throwaway data directory, so a test run can never
 * touch the runs and baselines a developer has accumulated locally.
 */

const NEXT_BIN = path.join("node_modules", "next", "dist", "bin", "next");
const PORT_FILE = path.join(os.tmpdir(), "uiproof-e2e-runtime.json");
const CANDIDATE_PORTS = [3210, 3211, 3212, 3213, 3214];
const READY_TIMEOUT_MS = 90_000;

export interface E2eRuntime {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly root: string;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  for (const port of CANDIDATE_PORTS) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port among ${CANDIDATE_PORTS.join(", ")} for the UIProof e2e server`);
}

async function waitForReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The e2e server exited with code ${child.exitCode} before it was ready`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`The e2e server did not become ready within ${READY_TIMEOUT_MS}ms (${lastError})`);
}

export async function startE2eServer(): Promise<{ runtime: E2eRuntime; stop: () => Promise<void> }> {
  const root = process.cwd();
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `pnpm build` before the browser suite (`pnpm test:e2e`).");
  }

  const port = await pickPort();
  const url = `http://localhost:${port}`;
  const dataDir = path.join(os.tmpdir(), `uiproof-e2e-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, UIPROOF_DATA_DIR: dataDir, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  try {
    await waitForReady(url, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log.join("")}`);
  }

  await writeFile(PORT_FILE, JSON.stringify({ url, port, dataDir, root } satisfies E2eRuntime), "utf8");

  return {
    runtime: { url, port, dataDir, root },
    stop: async () => {
      await rm(PORT_FILE, { force: true });
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * How a test finds the server: an environment variable when one is provided, otherwise
 * the runtime file the global setup wrote. The read is synchronous because a test needs
 * the URL before its first await, and the file is a few dozen bytes.
 */
export function readE2eRuntime(): E2eRuntime {
  const fromEnv = process.env.UIPROOF_E2E_URL;
  if (fromEnv) {
    return {
      url: fromEnv,
      port: Number(new URL(fromEnv).port),
      dataDir: process.env.UIPROOF_E2E_DATA_DIR ?? "",
      root: process.cwd(),
    };
  }
  try {
    return JSON.parse(readFileSync(PORT_FILE, "utf8")) as E2eRuntime;
  } catch {
    throw new Error(
      `The e2e runtime file (${PORT_FILE}) is missing — the global setup did not run. Start the suite with \`pnpm test:e2e\`.`,
    );
  }
}
