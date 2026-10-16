import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * The browser suites drive real production servers over HTTP.
 *
 * They run `next start` (not `next dev`) so the pages under test are the ones a user
 * would actually get, and by default against a throwaway data directory, so a test run
 * can never touch the runs and baselines a developer has accumulated locally.
 *
 * The server is always bound to `127.0.0.1`, which is the control that keeps remote
 * clients out of the local-only write endpoints — `Host: 127.0.0.1` is only a header a
 * client can write, but a socket bound to loopback cannot be connected to from another
 * machine at all.
 */

const NEXT_BIN = path.join("node_modules", "next", "dist", "bin", "next");
const PORT_FILE = path.join(os.tmpdir(), "uiproof-e2e-runtime.json");
const DEFAULT_CANDIDATE_PORTS = [3210, 3211, 3212, 3213, 3214, 3215, 3216, 3217];
const READY_TIMEOUT_MS = 90_000;

export interface E2eRuntime {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly root: string;
}

export interface StartE2eServerOptions {
  /** Extra environment for the server process (data dir, project config, …). */
  readonly env?: Readonly<Record<string, string>>;
  /** Reuse a data directory instead of creating — and deleting — a temporary one. */
  readonly dataDir?: string;
  /** Ports to try in order. Useful when several servers run in one suite. */
  readonly portCandidates?: readonly number[];
  /** Root the server runs from; defaults to the repository root. */
  readonly rootDir?: string;
  /** Human label used in log lines and error messages. */
  readonly label?: string;
  /** The global setup writes the shared runtime file; ad-hoc servers do not. */
  readonly writeRuntimeFile?: boolean;
}

export interface StartedE2eServer {
  readonly runtime: E2eRuntime;
  readonly stop: () => Promise<void>;
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

async function pickPort(candidates: readonly number[]): Promise<number> {
  for (const port of candidates) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port among ${candidates.join(", ")} for a UIProof e2e server`);
}

async function waitForReady(url: string, child: ChildProcess, log: string[]): Promise<void> {
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
  throw new Error(
    `The e2e server did not become ready within ${READY_TIMEOUT_MS}ms (${lastError})\n${log.join("")}`,
  );
}

export async function startE2eServer(options: StartE2eServerOptions = {}): Promise<StartedE2eServer> {
  const root = options.rootDir ?? process.cwd();
  const label = options.label ?? "uiproof";
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `pnpm build` before the browser suite (`pnpm test:e2e`).");
  }

  const port = await pickPort(options.portCandidates ?? DEFAULT_CANDIDATE_PORTS);
  const url = `http://127.0.0.1:${port}`;
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? path.join(os.tmpdir(), `uiproof-e2e-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  const child = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, UIPROOF_DATA_DIR: dataDir, NODE_ENV: "production", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  try {
    await waitForReady(url, child, log);
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log.join("")}`);
  }

  const runtime: E2eRuntime = { url, port, dataDir, root };
  if (options.writeRuntimeFile) {
    await writeFile(PORT_FILE, JSON.stringify(runtime satisfies E2eRuntime), "utf8");
  }
  process.stdout.write(`e2e: ${label} listening on ${url} (data: ${dataDir})\n`);

  return {
    runtime,
    stop: async () => {
      if (options.writeRuntimeFile) await rm(PORT_FILE, { force: true });
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
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
