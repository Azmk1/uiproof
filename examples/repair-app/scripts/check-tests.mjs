#!/usr/bin/env node
/**
 * The fixture's "test suite": asserts the properties the application is supposed to keep.
 * Independent of the deliberate defects, so it passes before and after a good repair and
 * fails only when a patch breaks the application.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manual = await readFile(path.join(root, "views", "manual.html"), "utf8");
const index = await readFile(path.join(root, "views", "index.html"), "utf8");

const checks = [
  ["manual page keeps its heading", manual.includes("<h1>Billing manual</h1>")],
  ["manual page keeps its landmark id", manual.includes('id="manual"')],
  ["the main page keeps its landmark", index.includes("<main")],
  // The fixture serves more than one view through index.html, so the form assertions
  // apply only to the view that has a form — and still catch a removed submit button.
  ["a form keeps its submit button", !index.includes("<form>") || index.includes('type="submit"')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`ok: ${checks.length} application checks passed`);
