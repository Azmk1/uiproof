import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Running the real CLI as a child process — the same way a developer or a CI job runs it.
 *
 * `scripts/uiproof.mjs` bundles the TypeScript CLI and executes it, so every suite that
 * needs a verdict goes through the actual entry point: no function calls, no stubs, and
 * the exit code comes from the process itself.
 */

export const CLI_ENTRY = path.join(process.cwd(), "scripts", "uiproof.mjs");
const CLI_TIMEOUT_MS = 180_000;

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed `--json` output; `null` when the command printed no JSON. */
  readonly json: Record<string, unknown> | null;
}

export interface CliOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`uiproof ${args.join(" ")} did not finish within ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? 2);
    });
  });

  const out = stdout.join("");
  let json: Record<string, unknown> | null = null;
  if (args.includes("--json")) {
    // `--json` promises exactly one JSON document on stdout and nothing else.
    json = JSON.parse(out) as Record<string, unknown>;
  }
  return { code, stdout: out, stderr: stderr.join(""), json };
}
