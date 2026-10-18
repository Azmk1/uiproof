import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExampleApp, type ExampleApp } from "./support/example-app";

/**
 * Phase 9: the release candidate, installed the way a consumer installs it.
 *
 * This suite never runs the repository's own CLI. It packs the package, unpacks it into a
 * throwaway project outside the checkout, installs its declared dependencies from the
 * registry, and drives *that* copy — a capture against an application in a different
 * directory, then a real verdict. What it asserts is what a consumer would notice if it
 * were wrong: the tarball's contents are exactly the CLI and its documents, the version the
 * binary reports is the version that was packed, the only dependencies installed are the
 * four the CLI actually loads, and a browser command works without a neighbouring UIProof
 * checkout.
 *
 * `pnpm pack` runs `prepack`, so the bundle under test is the one a release would publish.
 */

const ROOT = process.cwd();
const PACK_TIMEOUT_MS = 600_000;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The package manager, started the way its own shim starts it: `node <npm-cli.js> …`.
 *
 * `npm` and `pnpm` are shell scripts (and `.cmd` shims on Windows), which `execFile` cannot
 * start without a shell. Running the CLI entry directly is what the shim does, works on both
 * platforms, and keeps a test that installs a package from depending on how the machine's
 * shell resolves it.
 */
async function npmCli(): Promise<string> {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`Could not find npm's CLI entry point anywhere under ${nodeDir}.`);
}

/** `npm <args>` from the consumer's directory, with no shell in the way. */
async function npm(args: readonly string[], options: { cwd?: string } = {}): Promise<Run> {
  return run(process.execPath, [await npmCli(), ...args], options);
}

/**
 * Runs one process and returns its status verbatim.
 */
function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd ?? ROOT,
        env: { ...process.env, ...options.env, NEXT_TELEMETRY_DISABLED: "1" },
        timeout: PACK_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const numeric = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
        if (error && numeric === null && (error as { killed?: boolean }).killed) {
          reject(new Error(`${command} did not finish within ${PACK_TIMEOUT_MS}ms`));
          return;
        }
        resolve({ code: numeric ?? (error ? 1 : 0), stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

interface ArchiveEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * Reads a `.tgz` without a `tar` binary.
 *
 * The test asserts what the *package* contains on any machine, and the platform `tar` is
 * not portable enough for that: Git Bash's GNU tar reads `C:\…` as a remote host, while
 * bsdtar reads it as a path. A 512-byte-header reader is twenty lines and cannot disagree
 * with itself between platforms.
 */
function readArchive(tarball: Buffer): ArchiveEntry[] {
  const tar = gunzipSync(tarball);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\u0000.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\u0000.*$/, "").trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const data = tar.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, data: Buffer.from(data) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Every file under a directory, as paths relative to it, sorted. */
async function entriesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(directory, full).split(path.sep).join("/"));
    }
  };
  await walk(directory);
  return found.sort();
}

/** The file names inside a packed tarball, with npm's `package/` prefix removed. */
function archiveNames(entries: readonly ArchiveEntry[]): string[] {
  return entries
    .map((entry) => entry.name.replace(/^package\//, ""))
    .filter((name) => name.length > 0 && !name.endsWith("/"))
    .sort();
}

describe("packaged release candidate", () => {
  let workDir = "";
  let packDir = "";
  let installDir = "";
  let app: ExampleApp | null = null;
  let tarball = "";
  let version = "";

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-distribution-"));
    packDir = path.join(workDir, "pack");
    installDir = path.join(workDir, "consumer");
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });

    const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
      private: boolean;
    };
    version = manifest.version;

    const packed = await npm(["pack", "--pack-destination", packDir], { cwd: ROOT });
    expect(packed.code, packed.stderr || packed.stdout).toBe(0);

    const produced = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    expect(produced).toHaveLength(1);
    tarball = path.join(packDir, produced[0]);
    expect(path.basename(tarball)).toBe(`uiproof-${version}.tgz`);

    // The consumer: a package.json and nothing else. No checkout, no workspace, no link.
    await writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }, null, 2)}\n`,
      "utf8",
    );
    const installed = await npm(
      ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel", "error"],
      { cwd: installDir },
    );
    expect(installed.code, installed.stderr || installed.stdout).toBe(0);
  }, 1_800_000);

  afterAll(async () => {
    await app?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("ships the CLI bundle and its documents, and nothing else", async () => {
    const entries = archiveNames(readArchive(await readFile(tarball)));
    expect(entries).toEqual(
      [
        "CHANGELOG.md",
        "README.md",
        "bin/uiproof.mjs",
        "dist/cli/uiproof.mjs",
        "docs/REPAIR-SECURITY.md",
        "package.json",
      ].sort(),
    );
    for (const forbidden of ["src/", "e2e/", "examples/", "node_modules/", ".next/", "next.config.ts", "scripts/"]) {
      expect(entries.some((entry) => entry.startsWith(forbidden)), `${forbidden} is in the tarball`).toBe(false);
    }
  });

  it("installs only the dependencies the CLI loads", async () => {
    const modules = path.join(installDir, "node_modules");
    const installed = await readdir(modules);
    // Four runtime dependencies, their own tree, and the package itself:
    for (const required of ["axe-core", "pixelmatch", "playwright", "pngjs", "uiproof"]) {
      expect(installed, `${required} was not installed`).toContain(required);
    }
    // The dashboard's own dependencies must not travel with the CLI: a consumer installing
    // a gate should not download Next.js, React and a component framework for it.
    for (const forbidden of ["next", "react", "react-dom", "tailwindcss", "lucide-react"]) {
      expect(installed, `${forbidden} was installed with the CLI`).not.toContain(forbidden);
    }

    const resolved = await npm(["ls", "--depth=0", "--json"], { cwd: installDir });
    expect(resolved.code, resolved.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(modules, "uiproof", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      private?: boolean;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["axe-core", "pixelmatch", "playwright", "pngjs"]);
    // The publish guard stays on until the owner turns it off in the release checklist.
    expect(manifest.private).toBe(true);
  }, 120_000);

  it("reports the version that was packed and lists its commands", async () => {
    const installedBin = path.join(installDir, "node_modules", "uiproof", "bin", "uiproof.mjs");
    const versionRun = await run(process.execPath, [installedBin, "--version"], { cwd: installDir });
    expect(versionRun.code, versionRun.stderr).toBe(0);
    expect(versionRun.stdout.trim()).toBe(version);

    const help = await run(process.execPath, [installedBin, "--help"], { cwd: installDir });
    expect(help.code).toBe(0);
    for (const command of ["capture", "check", "audit", "diagnose", "repair", "baselines"]) {
      expect(help.stdout).toContain(command);
    }
    expect(help.stdout).toContain(version);
  }, 120_000);

  it("installs through the package manager's own bin shim", async () => {
    const shim = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "uiproof.CMD" : "uiproof");
    const shimmed =
      process.platform === "win32"
        ? await run("cmd.exe", ["/c", shim, "--version"], { cwd: installDir })
        : await run(shim, ["--version"], { cwd: installDir });
    expect(shimmed.code, shimmed.stderr).toBe(0);
    expect(shimmed.stdout.trim()).toBe(version);
  }, 120_000);

  it("captures a real page from an application outside the checkout", async () => {
    app = await startExampleApp();
    const storage = path.join(workDir, "store");
    const config = path.join(workDir, "uiproof.config.json");
    await writeFile(
      config,
      `${JSON.stringify(
        {
          projects: [
            {
              id: "example-app",
              name: "Example app",
              origin: app.url,
              routes: [{ id: "home", name: "Overview", path: "/" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const installedBin = path.join(installDir, "node_modules", "uiproof", "bin", "uiproof.mjs");
    const captured = await run(
      process.execPath,
      [
        installedBin,
        "capture",
        "--config",
        config,
        "--storage",
        storage,
        "--project",
        "example-app",
        "--route",
        "home",
        "--viewport",
        "desktop",
        "--json",
      ],
      { cwd: installDir },
    );
    expect(captured.code, captured.stderr).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { command?: string; status?: string };
    expect(parsed.command).toBe("capture");

    // The run landed in the store the consumer named — a real capture, from an application
    // in a different directory, by a copy of the CLI that has no checkout.
    const stored = await entriesUnder(storage);
    const reportPath = stored.find((entry) => /reports\/run-.*\.json$/.test(entry));
    expect(reportPath, `store held: ${stored.join(", ")}`).toBeDefined();
    const report = JSON.parse(await readFile(path.join(storage, reportPath!), "utf8")) as {
      status?: string;
      source?: { kind?: string; projectId?: string; routeId?: string };
      viewport?: { width?: number };
    };
    expect(report.status).toBeDefined();
    expect(report.source?.projectId).toBe("example-app");
    expect(report.source?.routeId).toBe("home");
    expect(report.viewport?.width ?? 0).toBeGreaterThan(0);
    // The capture itself is on disk: a run without its images is not evidence.
    expect(stored.join(" ")).toMatch(/current\.png/);
  }, 300_000);

  it("runs the gate from the installed copy against a changed page and exits 1", async () => {
    app = app ?? (await startExampleApp());
    const storage = path.join(workDir, "store");
    const config = path.join(workDir, "uiproof.config.json");
    const installedBin = path.join(installDir, "node_modules", "uiproof", "bin", "uiproof.mjs");

    // Approve the page as it is, then change it: the classic regression, judged by the
    // installed copy rather than by the checkout it was built in.
    const approved = await run(
      process.execPath,
      [installedBin, "capture", "--config", config, "--storage", storage, "--project", "example-app", "--route", "home", "--approve", "--json"],
      { cwd: installDir },
    );
    expect(approved.code, approved.stderr).toBe(0);

    await app.applyUiChange();
    const check = await run(
      process.execPath,
      [installedBin, "check", "--config", config, "--storage", storage, "--project", "example-app", "--route", "home", "--json"],
      { cwd: installDir },
    );
    expect(check.code, check.stderr).toBe(1);
    const verdict = JSON.parse(check.stdout) as { status?: string };
    expect(verdict.status).toBe("regression");

    await app.restoreUi();
    const restored = await run(
      process.execPath,
      [installedBin, "check", "--config", config, "--storage", storage, "--project", "example-app", "--route", "home", "--json"],
      { cwd: installDir },
    );
    expect(restored.code, restored.stderr).toBe(0);

    // An approved baseline keeps its image: the gate compared real pixels, not a summary.
    const stored = await entriesUnder(storage);
    expect(stored.join(" ")).toMatch(/baselines\/.*\.png/);
  }, 300_000);

  it("is reproducible: packing the same revision twice produces the same CLI bytes", async () => {
    const second = path.join(workDir, "pack-again");
    await mkdir(second, { recursive: true });
    const firstBundle = await readFile(path.join(ROOT, "dist", "cli", "uiproof.mjs"));
    const repacked = await npm(["pack", "--pack-destination", second], { cwd: ROOT });
    expect(repacked.code, repacked.stderr).toBe(0);
    const again = (await readdir(second)).filter((name) => name.endsWith(".tgz"));
    expect(again).toHaveLength(1);

    const entries = readArchive(await readFile(path.join(second, again[0])));
    const bundleB = entries.find((entry) => entry.name === "package/dist/cli/uiproof.mjs")?.data;
    expect(bundleB, "the second tarball has no CLI bundle").toBeDefined();
    expect(createHash("sha256").update(bundleB!).digest("hex")).toBe(
      createHash("sha256").update(firstBundle).digest("hex"),
    );
  }, 600_000);
});
