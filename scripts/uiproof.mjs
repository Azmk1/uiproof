#!/usr/bin/env node
/**
 * Runs the UIProof CLI from source.
 *
 *   pnpm uiproof check --project my-app --route home
 *   node scripts/uiproof.mjs --help
 *   node scripts/uiproof.mjs --build-only      # just refresh the bundle (pnpm build:cli)
 *
 * The CLI is TypeScript inside the application, so it is bundled with esbuild — the same
 * compiler Next uses for the app — into `.uiproof/cli/uiproof.mjs`, which is git-ignored.
 * The bundle is refreshed only when a source file is newer than it, so a warm invocation
 * costs one filesystem walk; `--build-only` always rebuilds. Playwright and the image
 * libraries stay external, because Playwright resolves its browser binaries relative to
 * its own package directory.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(root, "src", "cli", "main.ts");
const bundlePath = path.join(root, ".uiproof", "cli", "uiproof.mjs");

/** Newest modification time under a directory tree, ignoring anything not ours. */
async function newestMtime(directory) {
  let newest = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(full));
    } else if (/\.(ts|json)$/.test(entry.name)) {
      const info = await stat(full).catch(() => null);
      if (info) newest = Math.max(newest, info.mtimeMs);
    }
  }
  return newest;
}

async function bundle(force) {
  if (!force) {
    const info = await stat(bundlePath).catch(() => null);
    if (info && info.mtimeMs > (await newestMtime(path.join(root, "src")))) return bundlePath;
  }

  await mkdir(path.dirname(bundlePath), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // The codebase imports through the `@/*` alias; esbuild resolves it from here.
    alias: { "@": path.join(root, "src") },
    external: ["playwright", "playwright-core", "pixelmatch", "pngjs"],
    logLevel: "warning",
  });
  return bundlePath;
}

const args = process.argv.slice(2);

if (args[0] === "--build-only") {
  await bundle(true);
  process.stdout.write(`uiproof: built ${path.relative(root, bundlePath) || bundlePath}\n`);
} else {
  const outfile = await bundle(false);
  const child = spawn(process.execPath, [outfile, ...args], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 2 : (code ?? 2));
  });
}
