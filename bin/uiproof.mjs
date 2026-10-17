#!/usr/bin/env node
/**
 * The `uiproof` command an installed copy exposes.
 *
 * It runs `dist/cli/uiproof.mjs`, which `pnpm pack` builds from `src/cli/main.ts` with the
 * same esbuild bundler `pnpm uiproof` uses in this repository. Installing the package is
 * therefore the same CLI, not a second implementation and not a compile step on the
 * consumer's machine.
 *
 * Spawning is deliberate: the bundle runs its command only when it is the process entry
 * point (`process.argv[1]`), which keeps it importable by tests here. Importing it from a
 * launcher would load the module and do nothing.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "..", "dist", "cli", "uiproof.mjs");

try {
  statSync(bundle);
} catch {
  process.stderr.write(
    `uiproof: ${bundle} is missing. This copy was packed without its bundle — reinstall the ` +
      `package, or run "pnpm build:cli" in a checkout of UIProof.\n`,
  );
  process.exit(2);
}

const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (error) => {
  process.stderr.write(`uiproof: could not start the CLI: ${error.message}\n`);
  process.exit(2);
});
child.on("exit", (code, signal) => {
  // A signal is not a verdict: UIProof's own contract reserves 2 for "the tool could not
  // answer", and that is the honest status for a killed process.
  process.exit(signal ? 2 : (code ?? 2));
});
