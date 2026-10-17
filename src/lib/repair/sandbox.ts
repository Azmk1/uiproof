import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";

/**
 * The isolated checkout a repair may edit, and the only place generated application code
 * is ever executed.
 *
 * What this module guarantees:
 *
 *  · **A real copy.** The sandbox is a byte-for-byte copy of the registered source (minus
 *    dependencies, generated output, Git metadata and dotfiles), made before any proposal
 *    exists. Nothing outside that copy is written by a repair.
 *  · **No symlinks.** Symbolic links are skipped while copying, and every write is proven
 *    to resolve inside the sandbox root. A patch cannot follow a link out of the tree.
 *  · **A scrubbed environment.** Sandboxed commands receive an allow-list of environment
 *    variables (PATH, temp directories, locale) plus the sandbox's own PORT/HOST. Model
 *    keys, cloud credentials, Git tokens and UIProof's own store paths are never passed.
 *  · **No shell.** Commands are developer-authored argument vectors executed with
 *    `execFile(..., { shell: false })`. A model never supplies a command.
 *  · **Bounded.** File count, per-file size, total bytes, command output and run time are
 *    all capped, and a refused copy leaves the original untouched.
 *
 * What it is **not**: an operating-system sandbox. A build or test command that a
 * developer registers runs with that developer's own privileges. The isolation here is
 * filesystem- and environment-level, and the README states that assumption rather than
 * implying more.
 */

export const MAX_SANDBOX_FILES = 6000;
export const MAX_SANDBOX_BYTES = 64 * 1024 * 1024;
export const MAX_SANDBOX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_REPORTED_SKIPS = 40;
const COMMAND_OUTPUT_BUFFER = 1024 * 1024;
const MAX_OUTPUT_TAIL_LINES = 40;

/** Directories that are never part of a runnable source copy UIProof made itself. */
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
  "uiproof-baselines",
  "__pycache__",
]);

const SKIPPED_FILE = /\.(log|lock|map|tsbuildinfo|zip|tar|gz|tgz|7z|exe|dll|so|dylib|class)$/i;

export interface SandboxCopy {
  /** Canonical absolute root of the copy. */
  readonly root: string;
  /** Every copied file, relative with `/` separators. */
  readonly files: readonly string[];
  readonly bytes: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function inside(parent: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === parent || resolved.startsWith(parent + path.sep);
}

/**
 * Copies the source tree into `targetDir`. `targetDir` must not exist yet: a half-written
 * sandbox over an old one would make "the original is untouched" impossible to prove.
 */
export async function createSandboxCopy(sourceRoot: string, targetDir: string): Promise<SandboxCopy> {
  const root = path.resolve(targetDir);
  if (inside(sourceRoot, root)) {
    throw new ComparisonError(
      "repair_sandbox_failed",
      `The sandbox (${root}) must not be inside the source directory it copies.`,
    );
  }

  const files: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let bytes = 0;

  const skip = (relative: string, reason: string): void => {
    if (skipped.length < MAX_REPORTED_SKIPS) skipped.push({ path: relative, reason });
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      skip(toPosix(path.relative(sourceRoot, directory)) || ".", `deeper than ${MAX_DEPTH} levels`);
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      skip(toPosix(path.relative(sourceRoot, directory)) || ".", `could not be listed: ${(cause as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = toPosix(path.relative(sourceRoot, full));
      if (entry.name.startsWith(".")) {
        skip(relative, "hidden path (never copied)");
        continue;
      }
      if (entry.isSymbolicLink()) {
        skip(relative, "symbolic link (never followed)");
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          skip(relative, "dependency, generated or store directory");
          continue;
        }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skip(relative, "not a regular file");
        continue;
      }
      if (SKIPPED_FILE.test(entry.name)) {
        skip(relative, "generated, archive or log file");
        continue;
      }

      let info;
      try {
        info = await lstat(full);
      } catch (cause) {
        skip(relative, `could not be inspected: ${(cause as Error).message}`);
        continue;
      }
      if (info.size > MAX_SANDBOX_FILE_BYTES) {
        skip(relative, `larger than ${Math.round(MAX_SANDBOX_FILE_BYTES / 1024 / 1024)} MB`);
        continue;
      }
      if (files.length >= MAX_SANDBOX_FILES) {
        throw new ComparisonError(
          "repair_limits_exceeded",
          `The source directory has more than ${MAX_SANDBOX_FILES} files, which is too large to isolate safely.`,
        );
      }
      if (bytes + info.size > MAX_SANDBOX_BYTES) {
        throw new ComparisonError(
          "repair_limits_exceeded",
          `The source directory holds more than ${Math.round(MAX_SANDBOX_BYTES / 1024 / 1024)} MB, which is too large to isolate safely.`,
        );
      }

      const destination = path.join(root, relative);
      if (!inside(root, destination)) {
        skip(relative, "resolved outside the sandbox");
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(full, destination);
      files.push(relative);
      bytes += info.size;
    }
  };

  try {
    await walk(sourceRoot, 0);
  } catch (cause) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }

  return { root, files: files.sort(), bytes, skipped };
}

/** Writes one patched file, refusing any path that leaves the sandbox. */
export async function writeSandboxFile(sandboxRoot: string, relativePath: string, content: string): Promise<void> {
  const destination = path.resolve(sandboxRoot, relativePath);
  if (!inside(sandboxRoot, destination) || destination === path.resolve(sandboxRoot)) {
    throw new ComparisonError(
      "repair_scope_violation",
      `Refusing to write outside the sandbox: ${relativePath}`,
    );
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

/* ── Commands ──────────────────────────────────────────────────────────────── */

/** Environment variables a sandboxed command inherits. Everything else is dropped. */
const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "LANG",
  "LC_ALL",
  "TZ",
  "SHELL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

/**
 * The environment a sandboxed process gets. Deliberately an allow-list: a new secret added
 * to the developer's shell is not silently handed to generated application code.
 */
export function sandboxEnvironment(
  extra: Readonly<Record<string, string>> = {},
  url: string | null = null,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.NODE_ENV = "test";
  env.CI = "1";
  env.NO_COLOR = "1";
  if (url) {
    const parsed = new URL(url);
    env.PORT = parsed.port;
    env.HOST = parsed.hostname.replace(/^\[|\]$/g, "");
  }
  for (const [key, value] of Object.entries(extra)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export interface CommandOutcome {
  readonly status: "passed" | "failed";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputTail: string;
  readonly reason: string | null;
}

function tail(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return lines.slice(-MAX_OUTPUT_TAIL_LINES).join("\n").slice(-8_000);
}

/**
 * Runs one developer-configured command inside `cwd`. Never through a shell, never with
 * inherited secrets, always with a timeout and a bounded output.
 */
export async function runSandboxCommand(input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<CommandOutcome> {
  if (input.command.length === 0) {
    throw new ComparisonError("repair_sandbox_failed", "A sandbox command was empty.");
  }
  const started = Date.now();
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        input.command[0],
        input.command.slice(1),
        {
          cwd: input.cwd,
          env: sandboxEnvironment(input.env) as NodeJS.ProcessEnv,
          timeout: input.timeoutMs,
          maxBuffer: COMMAND_OUTPUT_BUFFER,
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error) {
            const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
            reject(
              Object.assign(new Error(failure.message), {
                code: failure.code,
                killed: failure.killed,
                stdout: failure.stdout ?? String(stdout ?? ""),
                stderr: failure.stderr ?? String(stderr ?? ""),
              }),
            );
            return;
          }
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });

    return {
      status: "passed",
      exitCode: 0,
      durationMs: Date.now() - started,
      outputTail: tail(`${result.stdout}\n${result.stderr}`),
      reason: null,
    };
  } catch (cause) {
    const failure = cause as Error & { killed?: boolean; code?: string | number; stdout?: string; stderr?: string };
    const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
    return {
      status: "failed",
      exitCode: typeof failure.code === "number" ? failure.code : null,
      durationMs: Date.now() - started,
      outputTail: tail(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message}`),
      reason: timedOut
        ? `The command did not finish within ${input.timeoutMs} ms and was stopped.`
        : failure.code === "ENOENT"
          ? `The command could not be started: ${input.command[0]} was not found.`
          : (failure.message ?? "The command failed."),
    };
  }
}

/* ── The sandbox server ────────────────────────────────────────────────────── */

const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_STOP_GRACE_MS = 750;
const MAX_SERVER_LOG_LINES = 30;

export interface RunningSandboxServer {
  readonly url: string;
  /** Last lines of the server's own output, bounded. */
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, SERVER_STOP_GRACE_MS));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/**
 * Starts the developer-registered sandbox server and waits for it to answer. A server that
 * never becomes ready, exits early or cannot own its port is a failed attempt, not a page
 * that happens to render nothing.
 */
export async function startSandboxServer(input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly url: string;
  readonly readyPath: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<RunningSandboxServer> {
  const parsed = new URL(input.url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ComparisonError("repair_sandbox_failed", `The sandbox URL must be http(s), got ${input.url}.`);
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!(await portIsFree(port))) {
    throw new ComparisonError(
      "repair_sandbox_failed",
      `Port ${port} is already in use, so UIProof cannot prove which process answered at ${input.url}. ` +
        "Stop that process or register a different sandbox url.",
    );
  }

  if (input.command.length === 0) {
    throw new ComparisonError("repair_sandbox_failed", "The registered sandbox command is empty.");
  }

  const child: ChildProcess = spawn(input.command[0], input.command.slice(1), {
    cwd: input.cwd,
    env: sandboxEnvironment(input.env, input.url) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
  });

  const log: string[] = [];
  const record = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim().length === 0) continue;
      log.push(line);
    }
    if (log.length > MAX_SERVER_LOG_LINES) log.splice(0, log.length - MAX_SERVER_LOG_LINES);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const readyUrl = `${input.url.replace(/\/+$/, "")}${input.readyPath}`;
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastError = "no response yet";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stopProcess(child);
      throw new ComparisonError(
        "repair_sandbox_failed",
        `The sandbox server exited with code ${child.exitCode} before it was ready.` +
          (log.length > 0 ? ` Output: ${log.slice(-8).join(" | ")}` : ""),
      );
    }
    try {
      const response = await fetch(readyUrl, { redirect: "manual", headers: { accept: "text/html,application/json" } });
      if (response.status === 200) {
        return {
          url: input.url,
          log: () => log.join("\n"),
          stop: () => stopProcess(child),
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (cause) {
      lastError = (cause as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stopProcess(child);
  throw new ComparisonError(
    "repair_sandbox_failed",
    `The sandbox server did not answer ${readyUrl} within ${SERVER_READY_TIMEOUT_MS} ms (${lastError}).` +
      (log.length > 0 ? ` Output: ${log.slice(-8).join(" | ")}` : ""),
  );
}
