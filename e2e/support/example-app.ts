import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Starts the independent example application for the browser suite.
 *
 * The application is copied to a temporary directory first, so the test can rewrite its
 * view files — which is exactly what "change the application's real UI" means here: the
 * server reads `views/` per request, so the next capture renders the edit. Nothing in the
 * repository copy is modified.
 */

const SOURCE_DIR = path.join(process.cwd(), "examples", "example-app");
const READY_TIMEOUT_MS = 20_000;

export interface ExampleAppRoute {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface ExampleApp {
  readonly url: string;
  readonly port: number;
  /** Working copy of the application the server is reading from. */
  readonly dir: string;
  /** Just start it (captures a route whose definition is registered). */
  readonly applyUiChange: () => Promise<void>;
  readonly restoreUi: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** The routes the integration test registers with UIProof. */
export const EXAMPLE_ROUTES: readonly ExampleAppRoute[] = [
  { id: "overview", name: "Overview", path: "/" },
  { id: "settings", name: "Settings", path: "/settings" },
  { id: "partners", name: "Partners", path: "/embedded" },
  { id: "redirects-away", name: "Redirects away", path: "/moved" },
];

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

export async function pickFreePort(candidates: readonly number[]): Promise<number> {
  for (const port of candidates) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port among ${candidates.join(", ")}`);
}

async function waitForHealth(url: string, child: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The example application exited with ${child.exitCode} before it was ready\n${log.join("")}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The example application did not answer /healthz within ${READY_TIMEOUT_MS}ms\n${log.join("")}`);
}

export async function startExampleApp(
  options: { readonly portCandidates?: readonly number[]; readonly port?: number } = {},
): Promise<ExampleApp> {
  const port = options.port ?? (await pickFreePort(options.portCandidates ?? [4273, 4274, 4275, 4276]));
  const dir = path.join(os.tmpdir(), `uiproof-example-app-${randomUUID()}`);
  await cp(SOURCE_DIR, dir, { recursive: true });

  const viewPath = path.join(dir, "views", "home.html");
  const changedViewPath = path.join(dir, "views", "home.changed.html");
  const originalView = await readFile(viewPath, "utf8");
  const changedView = await readFile(changedViewPath, "utf8");

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
  process.stdout.write(`e2e: example application listening on ${url} (${dir})\n`);

  return {
    url,
    port,
    dir,
    // A real edit to the application's own view: the next request renders the new screen.
    applyUiChange: async () => {
      await writeFile(viewPath, changedView, "utf8");
    },
    restoreUi: async () => {
      await writeFile(viewPath, originalView, "utf8");
    },
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

export interface ProjectRegistration {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly routes: readonly ExampleAppRoute[];
  readonly allowedOrigins?: readonly string[];
}

/** Writes a UIProof registration file — the same shape a developer would hand-write. */
export async function writeProjectConfig(
  configPath: string,
  projects: readonly ProjectRegistration[],
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ projects }, null, 2)}\n`, "utf8");
}

/** A registration whose `path` is not a safe, allow-listed route. */
export const UNSAFE_REGISTRATION: readonly ProjectRegistration[] = [
  {
    id: "sneaky",
    name: "Sneaky",
    origin: "http://127.0.0.1:4173",
    routes: [{ id: "escape", name: "Escape", path: "/../../etc/passwd" }],
  },
];
