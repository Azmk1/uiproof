#!/usr/bin/env node
/**
 * Runs the UIProof CLI from source.
 *
 *   pnpm uiproof check --project my-app --route home
 *   node scripts/uiproof.mjs --help
 *   node scripts/uiproof.mjs --build-only      # just refresh the bundle (pnpm build:cli)
 *   node scripts/uiproof.mjs --build-only --bundle-out dist/cli/uiproof.mjs   # the package's copy
 *
 * The CLI is TypeScript inside the application, so it is bundled with esbuild — the same
 * compiler Next uses for the app — into `.uiproof/cli/uiproof.mjs`, which is git-ignored.
 * The bundle is refreshed only when a source file is newer than it, so a warm invocation
 * costs one filesystem walk; `--build-only` always rebuilds. Playwright and the image
 * libraries stay external, because Playwright resolves its browser binaries relative to
 * its own package directory.
 *
 * `--bundle-out` writes the same bundle somewhere else. `pnpm pack` uses it to build
 * `dist/cli/` before packing, so an installed copy runs the CLI without esbuild or the
 * TypeScript sources — the distribution is the bundle, not a second implementation.
 *
 * The flag is deliberately *not* `--out`: the CLI has its own `--out <dir>` (where
 * `baselines export` writes a bundle) and it must reach the CLI untouched. The first
 * version of this script consumed it, which the browser suite caught.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(root, "src", "cli", "main.ts");
const defaultBundlePath = path.join(root, ".uiproof", "cli", "uiproof.mjs");

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

async function bundle(force, bundlePath = defaultBundlePath) {
  if (!force) {
    const info = await stat(bundlePath).catch(() => null);
    if (info && info.mtimeMs > (await newestMtime(path.join(root, "src")))) return bundlePath;
  }

  await mkdir(path.dirname(bundlePath), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: bundlePath,
    banner: { js: "#!/usr/bin/env node" },
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

// `--bundle-out <file>`: write somewhere other than the git-ignored dev cache. Consumed by
// `pnpm pack` (the package ships a prebuilt bundle) and useful when debugging the pack.
const outIndex = args.indexOf("--bundle-out");
const explicitOut = outIndex >= 0 ? args[outIndex + 1] : null;
const rest = outIndex >= 0 ? [...args.slice(0, outIndex), ...args.slice(outIndex + 2)] : args;
const bundlePath = explicitOut ? path.resolve(root, explicitOut) : defaultBundlePath;

if (rest[0] === "--build-only") {
  await bundle(true, bundlePath);
  process.stdout.write(`uiproof: built ${path.relative(root, bundlePath) || bundlePath}\n`);
} else {
  const outfile = await bundle(false, bundlePath);
  // `rest`, not `args`: the only difference is the script's own flag, which the CLI must
  // never see.
  const child = spawn(process.execPath, [outfile, ...rest], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 2 : (code ?? 2));
  });
}
