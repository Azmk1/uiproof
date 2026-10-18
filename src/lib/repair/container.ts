import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";
import {
  portIsFree,
  runSandboxCommand,
  sandboxEnvironment,
  startSandboxServer,
  type CommandOutcome,
  type RunningSandboxServer,
} from "./sandbox";
import type { RepairExecutionConfig, RepairExecutionRecord, SandboxCommandResult } from "./types";

/**
 * Container execution for the repair sandbox.
 *
 * The Phase 8 sandbox was a filesystem copy: it protected the developer's tree, and nothing
 * else. This module is the other half — the part that decides what the patched application
 * is allowed to touch. A repair runs generated application code and the developer's own
 * build and test commands, so both run inside a container:
 *
 *  · **No network interface at all.** `--network none` gives the container a loopback
 *    interface and nothing else. That is compatible with measuring a local application
 *    because UIProof does not need the container's network to reach it: a relay inside the
 *    container (`RELAY_SOURCE`) forwards its loopback HTTP onto the container's own stdio,
 *    and UIProof terminates that traffic on `127.0.0.1:<port>` on the host. Chromium keeps
 *    speaking plain HTTP to a loopback URL that happens to be served by a container.
 *  · **One writable mount.** The temporary checkout at `/work`. The container's root
 *    filesystem is read-only (`--read-only`) with `tmpfs` for `/tmp` and `/run`, so a patch
 *    cannot rewrite the image, install a package or persist anything outside the copy.
 *  · **No capabilities, no privilege escalation.** `--cap-drop ALL` and
 *    `--security-opt no-new-privileges`.
 *  · **Bounded resources.** A memory limit, a CPU limit and a PID limit, each configurable,
 *    so a build that forks forever is killed by the runtime rather than by the machine.
 *  · **No credentials.** The environment is an allow-list that excludes anything secret-ish,
 *    and the registration refuses secret-looking variable names outright.
 *
 * What this is not: a virtual machine. The container shares the host kernel, so its strength
 * is the runtime's isolation plus the flags above — enough for "a model's patch must not
 * reach my home directory, my keys or the internet", not a defence against a kernel exploit.
 * `docs/REPAIR-SECURITY.md` states exactly that, and the run record carries the same words.
 *
 * Host execution still exists, because a machine without a container runtime must be able to
 * say no explicitly rather than silently run unisolated code. It requires
 * `execution.trustHostExecution: true` in the registration and is recorded in the run.
 */

/* ── The relay ─────────────────────────────────────────────────────────────── */

/**
 * The relay that runs inside the container and bridges the application's loopback HTTP to
 * the container's stdio. It is UIProof's own code, mounted read-only, never model output.
 * Frames are newline-delimited: `OPEN <id>`, `DATA <id> <base64>`, `CLOSE <id>`, `STOP` in,
 * and `READY`, `DATA`, `CLOSE`, `LOG`, `EXIT`, `FATAL` out.
 */
export const RELAY_FILENAME = "relay.mjs";
export const RELAY_SOURCE = `// UIProof repair relay — generated, do not edit. Bridges loopback HTTP to stdio.
import { spawn } from "node:child_process";
import net from "node:net";

const port = Number(process.argv[2]);
const command = process.argv.slice(3);
const workdir = process.env.UIPROOF_WORKDIR ?? "/work";

function frame(kind, value = "") {
  process.stdout.write(value === "" ? kind + "\\n" : kind + " " + value + "\\n");
}

function fatal(message) {
  frame("FATAL", Buffer.from(String(message), "utf8").toString("base64"));
  setTimeout(() => process.exit(2), 50);
}

if (!Number.isFinite(port) || command.length === 0) fatal("relay: expected a port and a command");

const child = spawn(command[0], command.slice(1), {
  cwd: workdir,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let pending = "";
function pump(stream) {
  stream.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\\n");
    pending = lines.pop() ?? "";
    for (const line of lines) frame("LOG", Buffer.from(line, "utf8").toString("base64"));
    if (pending.length > 65536) {
      frame("LOG", Buffer.from(pending.slice(0, 65536), "utf8").toString("base64"));
      pending = "";
    }
  });
}
pump(child.stdout);
pump(child.stderr);

const connections = new Map();
let stopping = false;

function closeAll() {
  for (const socket of connections.values()) socket.destroy();
  connections.clear();
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  closeAll();
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
    process.exit(exitCode);
  }, 800).unref();
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));

child.on("exit", (code, signal) => {
  frame("EXIT", String(code === null ? (signal ? -1 : 0) : code));
  setTimeout(() => process.exit(code === null ? 1 : code), 50);
});
child.on("error", (error) => {
  fatal("relay: could not start the application command: " + error.message);
});

function handleOpen(id) {
  const socket = net.connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  connections.set(id, socket);
  socket.on("data", (chunk) => frame("DATA", id + " " + chunk.toString("base64")));
  socket.on("end", () => {
    connections.delete(id);
    frame("CLOSE", id);
  });
  socket.on("error", (error) => {
    connections.delete(id);
    frame("LOG", Buffer.from("relay: " + error.message + " (127.0.0.1:" + port + ")", "utf8").toString("base64"));
    frame("CLOSE", id);
  });
}

function handleLine(line) {
  const space = line.indexOf(" ");
  const kind = space === -1 ? line : line.slice(0, space);
  const rest = space === -1 ? "" : line.slice(space + 1);
  if (kind === "OPEN") return handleOpen(rest);
  if (kind === "DATA") {
    const second = rest.indexOf(" ");
    const socket = connections.get(rest.slice(0, second));
    if (socket) socket.write(Buffer.from(rest.slice(second + 1), "base64"));
    return undefined;
  }
  if (kind === "CLOSE") {
    const socket = connections.get(rest);
    if (socket) {
      connections.delete(rest);
      socket.end();
    }
    return undefined;
  }
  if (kind === "STOP") return stop(0);
  return undefined;
}

let leftover = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  leftover += chunk;
  const lines = leftover.split("\\n");
  leftover = lines.pop() ?? "";
  for (const line of lines) if (line.length > 0) handleLine(line);
});
process.stdin.on("end", () => stop(0));
process.stdin.on("close", () => stop(0));

frame("READY");
`;

/* ── Runtime detection ─────────────────────────────────────────────────────── */

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CACHE_MS = 60_000;
const IMAGE_PULL_TIMEOUT_MS = 15 * 60_000;

export interface ContainerRuntime {
  /** `docker` or `podman`. */
  readonly runtime: "docker" | "podman";
  readonly binary: string;
  readonly serverVersion: string;
}

export type ContainerProbe =
  | { readonly available: true; readonly runtime: ContainerRuntime; readonly reason: null }
  | { readonly available: false; readonly runtime: null; readonly reason: string };

export type ProbeRunner = (
  binary: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; error: string | null }>;

const defaultProbeRunner: ProbeRunner = async (binary, args, timeoutMs) => {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        binary,
        [...args],
        { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, shell: false },
        (error, out) => {
          if (error) {
            reject(Object.assign(new Error(error.message), { code: error.code }));
            return;
          }
          resolve({ stdout: String(out ?? "") });
        },
      );
    });
    return { ok: true, stdout, error: null };
  } catch (cause) {
    const failure = cause as Error & { code?: string | number };
    return {
      ok: false,
      stdout: "",
      error:
        failure.code === "ENOENT" ? `${binary} is not installed or not on PATH` : (failure.message ?? `${binary} failed`),
    };
  }
};

interface CachedProbe {
  readonly key: string;
  readonly at: number;
  readonly probe: ContainerProbe;
}

let probeCache: CachedProbe | null = null;

/** Drops the probe cache. Used by tests and by callers that just started a runtime. */
export function resetContainerProbeCache(): void {
  probeCache = null;
}

/**
 * Looks for a container runtime and proves it answers. A missing CLI, a stopped daemon and a
 * CLI that never returns are three different failures, and each is reported in words the
 * developer can act on.
 */
export async function probeContainerRuntime(
  options: {
    readonly runtime?: RepairExecutionConfig["runtime"];
    readonly run?: ProbeRunner;
    readonly refresh?: boolean;
    readonly now?: () => number;
  } = {},
): Promise<ContainerProbe> {
  const wanted = options.runtime ?? "auto";
  const run = options.run ?? defaultProbeRunner;
  const now = options.now ?? Date.now;
  const binaries = wanted === "auto" ? ["docker", "podman"] : [wanted];
  const key = binaries.join(",");

  if (!options.refresh && probeCache && probeCache.key === key && now() - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.probe;
  }

  const failures: string[] = [];
  let probe: ContainerProbe = { available: false, runtime: null, reason: "No container runtime was found." };

  for (const binary of binaries) {
    const version = await run(binary, ["version", "--format", "{{.Server.Version}}"], PROBE_TIMEOUT_MS);
    if (version.ok && version.stdout.trim().length > 0) {
      probe = {
        available: true,
        runtime: { runtime: binary as "docker" | "podman", binary, serverVersion: version.stdout.trim() },
        reason: null,
      };
      break;
    }
    failures.push(`${binary}: ${version.error ?? "no server version was reported"}`);
  }

  if (!probe.available) {
    probe = { available: false, runtime: null, reason: `No container runtime answered (${failures.join("; ")}).` };
  }

  probeCache = { key, at: now(), probe };
  return probe;
}

/* ── Isolation flags ───────────────────────────────────────────────────────── */

/** The only path inside the container that is writable. */
export const CONTAINER_WORK_DIR = "/work";
export const CONTAINER_RELAY_DIR = "/uiproof-relay";

export interface ContainerSandbox {
  readonly runtime: string;
  readonly serverVersion: string;
  readonly image: string;
  readonly config: RepairExecutionConfig;
  /** Host directory holding the temporary checkout, mounted read-write at `/work`. */
  readonly sandboxDir: string;
  /** Host directory holding the relay, mounted read-only. */
  readonly helperDir: string;
  /** Unique suffix for container names, so a leftover container can be identified. */
  readonly runId: string;
}

export interface HardeningOptions {
  /** How the dependency volume is attached. `install` is the only writer. */
  readonly dependencies?: "ro" | "rw" | "none";
  /** Overrides the configured network, used only for the one-time dependency install. */
  readonly network?: "none" | "egress";
}

function hostPathForMount(value: string): string {
  // Docker accepts forward slashes on Windows; normalising avoids ambiguity in `--mount`.
  return path.resolve(value).split(path.sep).join("/");
}

/** Variables that describe the host, not the container. */
const WINDOWS_ONLY_ENV = new Set([
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "SYSTEMROOT",
  "SystemRoot",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "SHELL",
]);

/**
 * The hardening flags. Exported so a test can assert them without starting a container, and
 * so the recorded isolation summary and the real invocation cannot drift apart.
 */
export function containerHardeningArgs(
  sandbox: ContainerSandbox,
  options: HardeningOptions = {},
): string[] {
  const config = sandbox.config;
  const network = options.network ?? config.network;
  const dependencies = options.dependencies ?? (config.dependenciesVolume ? "ro" : "none");
  const args = [
    "--rm",
    "--init",
    "--network",
    network === "none" ? "none" : "bridge",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--tmpfs",
    "/run:rw,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(config.pidsLimit),
    "--memory",
    `${config.memoryMb}m`,
    "--memory-swap",
    `${config.memoryMb}m`,
    "--cpus",
    String(config.cpus),
  ];
  if (config.user) args.push("--user", config.user);
  args.push(
    "--mount",
    `type=bind,source=${hostPathForMount(sandbox.sandboxDir)},target=${CONTAINER_WORK_DIR}`,
    "--mount",
    `type=bind,source=${hostPathForMount(sandbox.helperDir)},target=${CONTAINER_RELAY_DIR},readonly`,
    "--workdir",
    CONTAINER_WORK_DIR,
    "--env",
    `UIPROOF_WORKDIR=${CONTAINER_WORK_DIR}`,
    "--env",
    "HOME=/tmp",
    "--env",
    "XDG_CACHE_HOME=/tmp/.cache",
    "--env",
    "npm_config_cache=/tmp/.npm",
    "--label",
    `uiproof.repair=${sandbox.runId}`,
  );
  if (config.dependenciesVolume && dependencies !== "none") {
    args.push(
      "--mount",
      `type=volume,source=${config.dependenciesVolume},target=${CONTAINER_WORK_DIR}/node_modules${dependencies === "ro" ? ",readonly" : ""}`,
    );
  }
  return args;
}

/** Environment passed with `-e`, built from the same allow-list host commands use. */
export function containerEnvArgs(
  extra: Readonly<Record<string, string>> = {},
  url: string | null = null,
): string[] {
  const env = sandboxEnvironment(extra, url);
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key === "PATH" || WINDOWS_ONLY_ENV.has(key)) continue;
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

/** One `docker run` for a command. `-i` is only used for the relayed server. */
export function containerCommandArgs(input: {
  readonly sandbox: ContainerSandbox;
  readonly name: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string | null;
  readonly interactive?: boolean;
  readonly hardening?: HardeningOptions;
}): string[] {
  return [
    "run",
    ...containerHardeningArgs(input.sandbox, input.hardening ?? {}),
    "--name",
    input.name,
    ...(input.interactive ? ["-i"] : []),
    ...containerEnvArgs(input.env ?? {}, input.url ?? null),
    input.sandbox.image,
    ...[...input.command],
  ];
}

/**
 * A complete execution configuration. Used by the parser's defaults and by tests, so a
 * fixture cannot accidentally describe half a mode.
 */
export function executionConfig(overrides: Partial<RepairExecutionConfig> = {}): RepairExecutionConfig {
  return {
    mode: "container",
    runtime: "auto",
    image: null,
    network: "none",
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    user: null,
    dependenciesVolume: null,
    install: null,
    trustHostExecution: false,
    ...overrides,
  };
}

/** The run's own description of what isolated it. Never claims more than the flags above. */
export function executionRecordOf(input: {
  readonly mode: "container" | "host";
  readonly runtime?: ContainerRuntime | null;
  readonly config: RepairExecutionConfig | null;
}): RepairExecutionRecord {
  const config = input.config;
  if (input.mode === "host" || !input.runtime) {
    return {
      mode: "host",
      runtime: null,
      serverVersion: null,
      image: null,
      network: null,
      readOnlyRoot: false,
      capDropAll: false,
      noNewPrivileges: false,
      memoryMb: null,
      cpus: null,
      pidsLimit: null,
      user: null,
      dependenciesVolume: null,
      summary:
        "Host execution: the patched application and the configured commands ran as child processes of UIProof with the developer's own privileges. The sandbox was a filesystem copy, not an OS security boundary.",
    };
  }
  return {
    mode: "container",
    runtime: input.runtime.runtime,
    serverVersion: input.runtime.serverVersion,
    image: config?.image ?? null,
    network: config?.network ?? "none",
    readOnlyRoot: true,
    capDropAll: true,
    noNewPrivileges: true,
    memoryMb: config?.memoryMb ?? null,
    cpus: config?.cpus ?? null,
    pidsLimit: config?.pidsLimit ?? null,
    user: config?.user ?? null,
    dependenciesVolume: config?.dependenciesVolume ?? null,
    summary:
      `Container execution (${input.runtime.runtime} ${input.runtime.serverVersion}, image ${config?.image ?? "unknown"}): ` +
      "read-only root filesystem, all capabilities dropped, no-new-privileges, " +
      `${config?.memoryMb ?? 0} MB memory, ${config?.cpus ?? 0} CPU(s), ${config?.pidsLimit ?? 0} process(es), ` +
      (config?.network === "egress"
        ? "the default bridge network, so the container can reach the network."
        : "no network interface at all — UIProof reaches the application over a stdio relay."),
  };
}

/* ── Executor ──────────────────────────────────────────────────────────────── */

/**
 * The interface the engine runs everything through. Two implementations: container (below)
 * and host (a thin wrapper over `sandbox.ts`, used only when the registration explicitly
 * trusts it).
 */
export interface RepairExecutor {
  readonly mode: "container" | "host";
  readonly record: RepairExecutionRecord;
  /** True when the sandbox is a filesystem copy only. */
  readonly unisolated: boolean;
  runCommand(input: {
    readonly name: "build" | "test";
    readonly command: readonly string[];
    readonly timeoutMs: number;
  }): Promise<SandboxCommandResult>;
  startServer(input: {
    readonly command: readonly string[];
    readonly url: string;
    readonly readyPath: string;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<RunningSandboxServer>;
  cleanup(): Promise<void>;
}

function containerNameOf(runId: string, suffix: string): string {
  return `uiproof-repair-${runId}-${suffix}`.slice(0, 60);
}

/* ── The stdio bridge ──────────────────────────────────────────────────────── */

const SERVER_READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 1_500;
const MAX_RELAY_LOG_LINES = 30;

/**
 * Terminates the container's relayed HTTP on a loopback port, so everything downstream —
 * Playwright, axe-core, the comparison engine — keeps talking to `http://127.0.0.1:<port>`
 * while the application itself has no network interface.
 */
async function startBridgedServer(input: {
  readonly sandbox: ContainerSandbox;
  readonly command: readonly string[];
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

  const name = containerNameOf(input.sandbox.runId, "server");
  const args = containerCommandArgs({
    sandbox: input.sandbox,
    name,
    command: ["node", `${CONTAINER_RELAY_DIR}/${RELAY_FILENAME}`, String(port), ...input.command],
    url: input.url,
    interactive: true,
    ...(input.env ? { env: input.env } : {}),
  });

  const child: ChildProcess = spawn(input.sandbox.runtime, args, {
    cwd: input.sandbox.sandboxDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

  const log: string[] = [];
  const recordLine = (text: string): void => {
    if (text.trim().length === 0) return;
    log.push(text);
    if (log.length > MAX_RELAY_LOG_LINES) log.splice(0, log.length - MAX_RELAY_LOG_LINES);
  };

  const sockets = new Map<number, net.Socket>();
  let nextId = 1;
  let exited = false;
  let exitCode: number | null = null;

  const send = (frame: string): void => {
    if (child.stdin?.writable) child.stdin.write(`${frame}\n`);
  };

  const destroySockets = (): void => {
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
  };

  child.on("exit", (code) => {
    exited = true;
    exitCode = code ?? null;
    destroySockets();
  });
  child.on("error", (error: Error) => recordLine(`the container runtime could not be started: ${error.message}`));
  child.stderr?.on("data", (chunk: Buffer) => recordLine(chunk.toString()));

  let protocolBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    protocolBuffer += chunk.toString("utf8");
    const lines = protocolBuffer.split("\n");
    protocolBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      const space = line.indexOf(" ");
      const kind = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? "" : line.slice(space + 1);
      if (kind === "LOG" || kind === "FATAL") recordLine(Buffer.from(rest, "base64").toString("utf8"));
      else if (kind === "DATA") {
        const second = rest.indexOf(" ");
        const socket = sockets.get(Number(rest.slice(0, second)));
        if (socket) socket.write(Buffer.from(rest.slice(second + 1), "base64"));
      } else if (kind === "CLOSE") {
        const id = Number(rest);
        const socket = sockets.get(id);
        if (socket) {
          sockets.delete(id);
          socket.end();
        }
      }
    }
  });

  // The listener Chromium talks to. One host connection becomes one relayed connection.
  const listener = net.createServer((socket) => {
    if (exited) {
      socket.destroy();
      return;
    }
    const id = nextId;
    nextId += 1;
    sockets.set(id, socket);
    socket.setNoDelay(true);
    send(`OPEN ${id}`);
    socket.on("data", (data: Buffer) => send(`DATA ${id} ${data.toString("base64")}`));
    socket.on("end", () => {
      sockets.delete(id);
      send(`CLOSE ${id}`);
    });
    socket.on("error", () => {
      sockets.delete(id);
      send(`CLOSE ${id}`);
    });
  });

  const stop = async (): Promise<void> => {
    send("STOP");
    child.stdin?.end();
    const deadline = Date.now() + STOP_GRACE_MS;
    while (!exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    destroySockets();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (!exited) {
      await new Promise<void>((resolve) => {
        execFile(input.sandbox.runtime, ["rm", "-f", name], { timeout: 30_000, windowsHide: true }, () => resolve());
      });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", (error) => reject(error));
      listener.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (cause) {
    await stop();
    throw new ComparisonError(
      "repair_sandbox_failed",
      `UIProof could not listen on ${input.url} for the relayed sandbox: ${(cause as Error).message}`,
    );
  }

  const readyUrl = `${input.url.replace(/\/+$/, "")}${input.readyPath}`;
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastError = "no response yet";

  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new ComparisonError(
        "repair_sandbox_failed",
        `The sandbox container exited with code ${exitCode} before it was ready.` +
          (log.length > 0 ? ` Output: ${log.slice(-8).join(" | ")}` : ""),
      );
    }
    try {
      const response = await fetch(readyUrl, { redirect: "manual", headers: { accept: "text/html,application/json" } });
      if (response.status === 200) {
        return { url: input.url, log: () => log.join("\n"), stop };
      }
      lastError = `HTTP ${response.status}`;
    } catch (cause) {
      lastError = (cause as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stop();
  throw new ComparisonError(
    "repair_sandbox_failed",
    `The sandbox container did not answer ${readyUrl} within ${SERVER_READY_TIMEOUT_MS} ms (${lastError}).` +
      (log.length > 0 ? ` Output: ${log.slice(-8).join(" | ")}` : ""),
  );
}

/* ── Creating an executor ──────────────────────────────────────────────────── */

export interface ExecutorInput {
  readonly config: RepairExecutionConfig;
  readonly sandboxDir: string;
  readonly helperDir: string;
  readonly runId: string;
  /** Injected in tests. */
  readonly probe?: ContainerProbe;
  /** Injected in tests: whether the image is already present. */
  readonly imagePresent?: (image: string) => Promise<boolean>;
  readonly onWarning?: (message: string) => void;
}

/** Writes the relay next to the checkout, never inside it: the sandbox cannot edit it. */
export async function writeRelay(helperDir: string): Promise<string> {
  await mkdir(helperDir, { recursive: true });
  const target = path.join(helperDir, RELAY_FILENAME);
  await writeFile(target, RELAY_SOURCE, "utf8");
  return target;
}

/**
 * Make the throwaway checkout writable by whatever user the image runs as.
 *
 * The container runs as the image's own user with every capability dropped, so even uid 0
 * has no `DAC_OVERRIDE`: the copy's own permission bits apply. A copy created under a `0700`
 * temporary directory — or with `0755` directories owned by the host user — is therefore
 * unwritable inside the sandbox, and a build that creates `dist/` or `.next/` fails with
 * `EACCES`. Docker Desktop's file sharing hides that; a Linux host does not. The copy is
 * disposable and the container's own boundary is unchanged, so the copy is opened up rather
 * than the mount relaxed. Symlinks are skipped: `chmod` would follow one out of the copy.
 */
export async function makeSandboxWritable(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    await chmod(directory, 0o777);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile()) {
        // Read and write for every user the image might use; if the file is executable at
        // all, executable for all of them too, or a build script would fail for a non-owner.
        const mode = (await stat(target)).mode & 0o777;
        const executable = (mode & 0o111) !== 0 ? 0o111 : 0;
        await chmod(target, mode | 0o666 | executable);
      }
    }
  }
}

async function commandOutcome(
  runtime: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandOutcome> {
  return runSandboxCommand({ command: [runtime, ...args], cwd: process.cwd(), timeoutMs });
}

async function runContainerCommand(input: {
  readonly sandbox: ContainerSandbox;
  readonly name: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly hardening?: HardeningOptions;
  readonly url?: string | null;
}): Promise<CommandOutcome> {
  const name = containerNameOf(input.sandbox.runId, input.name);
  const args = containerCommandArgs({
    sandbox: input.sandbox,
    name,
    command: input.command,
    ...(input.hardening ? { hardening: input.hardening } : {}),
    ...(input.url ? { url: input.url } : {}),
  });
  const outcome = await runSandboxCommand({
    command: [input.sandbox.runtime, ...args],
    cwd: input.sandbox.sandboxDir,
    timeoutMs: input.timeoutMs,
  });
  const timedOut = outcome.status === "failed" && (outcome.reason?.includes("did not finish") ?? false);
  if (timedOut) {
    // Killing the CLI does not stop the container; it is named, so the runtime can.
    await new Promise<void>((resolve) => {
      execFile(input.sandbox.runtime, ["rm", "-f", name], { timeout: 30_000, windowsHide: true }, () => resolve());
    });
  }
  return outcome;
}

/**
 * Builds the executor for a run. Container mode refuses to fall back: a machine that cannot
 * provide isolation is told to say so explicitly, because a silent downgrade to host
 * execution is exactly the outcome Phase 9 exists to prevent.
 */
export async function createRepairExecutor(input: ExecutorInput): Promise<RepairExecutor> {
  const config = input.config;
  const warn = input.onWarning ?? ((): void => undefined);

  if (config.mode === "host") {
    if (!config.trustHostExecution) {
      throw new ComparisonError(
        "repair_unavailable",
        "Host execution is not trusted, so no repair was attempted. Set repair.execution.trustHostExecution to true " +
          "in uiproof.config.json to run generated code with your own privileges, or register a container image " +
          "(repair.execution.image) to run it isolated.",
      );
    }
    warn(
      "This run used host execution: the patched application and the configured commands ran with your own privileges. " +
        "The sandbox was a filesystem copy, not an OS security boundary.",
    );
    return {
      mode: "host",
      unisolated: true,
      record: executionRecordOf({ mode: "host", config }),
      runCommand: async ({ name, command, timeoutMs }) => {
        const outcome = await runSandboxCommand({ command, cwd: input.sandboxDir, timeoutMs });
        return {
          name,
          command,
          status: outcome.status,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          outputTail: outcome.outputTail,
          reason: outcome.reason,
        };
      },
      startServer: (serverInput) =>
        startSandboxServer({
          command: serverInput.command,
          cwd: input.sandboxDir,
          url: serverInput.url,
          readyPath: serverInput.readyPath,
          ...(serverInput.env ? { env: serverInput.env } : {}),
        }),
      cleanup: async () => undefined,
    };
  }

  if (!config.image) {
    throw new ComparisonError(
      "repair_unavailable",
      'Container execution is selected but no image is registered. Add "repair.execution.image" ' +
        '(for example "node:24-bookworm-slim") to uiproof.config.json.',
    );
  }

  const probe = input.probe ?? (await probeContainerRuntime({ runtime: config.runtime }));
  if (!probe.available) {
    throw new ComparisonError(
      "repair_unavailable",
      `${probe.reason} Container execution is the default because it is the only mode UIProof can call isolated; ` +
        "install a container runtime, or register \"repair.execution.mode\": \"host\" with \"trustHostExecution\": true " +
        "to run generated code with your own privileges.",
    );
  }

  const runtime = probe.runtime;
  const sandbox: ContainerSandbox = {
    runtime: runtime.binary,
    serverVersion: runtime.serverVersion,
    image: config.image,
    config,
    sandboxDir: input.sandboxDir,
    helperDir: input.helperDir,
    runId: input.runId,
  };

  await writeRelay(input.helperDir);
  await makeSandboxWritable(input.sandboxDir);

  // The image must exist before the run starts: pulling inside a run would either fail under
  // `--network none` or silently reach the network from inside the sandbox.
  const present = input.imagePresent ?? (async (image: string) => {
    const inspected = await runSandboxCommand({
      command: [runtime.binary, "image", "inspect", image, "--format", "{{.Id}}"],
      cwd: input.sandboxDir,
      timeoutMs: 60_000,
    });
    return inspected.status === "passed";
  });

  if (!(await present(config.image))) {
    warn(`The sandbox image ${config.image} was not present locally and is being pulled now (on the host, not in the sandbox).`);
    const pulled = await commandOutcome(runtime.binary, ["pull", config.image], IMAGE_PULL_TIMEOUT_MS);
    if (pulled.status === "failed") {
      throw new ComparisonError(
        "repair_unavailable",
        `The sandbox image ${config.image} could not be pulled: ${pulled.reason ?? "the runtime refused it"}\n${pulled.outputTail}`,
      );
    }
  }

  if (config.dependenciesVolume) {
    const volume = await runSandboxCommand({
      command: [runtime.binary, "volume", "inspect", config.dependenciesVolume, "--format", "{{.Name}}"],
      cwd: input.sandboxDir,
      timeoutMs: 30_000,
    });

    if (volume.status === "failed") {
      if (!config.install) {
        throw new ComparisonError(
          "repair_unavailable",
          `The dependency volume "${config.dependenciesVolume}" does not exist and no "repair.execution.install" command ` +
            `is registered to populate it. Create it with: ${runtime.binary} volume create ${config.dependenciesVolume}`,
        );
      }
      warn(
        `Dependencies were installed into the volume "${config.dependenciesVolume}" once, with network access. ` +
          "Every command after that ran with no network interface.",
      );
      const installed = await installDependencies({ config, sandbox });
      if (installed.status === "failed") {
        throw new ComparisonError(
          "repair_unavailable",
          `Installing dependencies into "${config.dependenciesVolume}" failed: ${installed.reason ?? "the command failed"}\n${installed.outputTail}`,
        );
      }
    }
  }

  return {
    mode: "container",
    unisolated: false,
    record: executionRecordOf({ mode: "container", runtime, config }),
    runCommand: async ({ name, command, timeoutMs }) => {
      const outcome = await runContainerCommand({ sandbox, name, command, timeoutMs });
      return {
        name,
        command,
        status: outcome.status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        outputTail: outcome.outputTail,
        reason: outcome.reason,
      };
    },
    startServer: (serverInput) =>
      startBridgedServer({
        sandbox,
        command: serverInput.command,
        url: serverInput.url,
        readyPath: serverInput.readyPath,
        ...(serverInput.env ? { env: serverInput.env } : {}),
      }),
    cleanup: async () => {
      // `--rm` already removes the containers; one killed mid-run can survive, so anything
      // carrying this run's name is removed explicitly.
      for (const suffix of ["build", "test", "install", "server"]) {
        await new Promise<void>((resolve) => {
          execFile(
            runtime.binary,
            ["rm", "-f", containerNameOf(input.runId, suffix)],
            { timeout: 30_000, windowsHide: true },
            () => resolve(),
          );
        });
      }
    },
  };
}

/** One-time population of the dependency volume, run with network access. */
export async function installDependencies(input: {
  readonly config: RepairExecutionConfig;
  readonly sandbox: ContainerSandbox;
}): Promise<CommandOutcome> {
  if (!input.config.install) {
    throw new ComparisonError("repair_unavailable", "No install command is registered.");
  }
  return runContainerCommand({
    sandbox: input.sandbox,
    name: "install",
    command: input.config.install,
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
    hardening: { network: "egress", dependencies: "rw" },
  });
}
