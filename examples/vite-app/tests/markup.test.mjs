import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The fixture's test command, run inside the repair sandbox on the unmodified source and
 * again on every candidate.
 *
 * These are invariants rather than assertions about the defect: they pass on the source as
 * it is, and a candidate that removes the accessibility finding by deleting the field, or
 * "fixes" the overflow by clipping the panel, fails them. That is what makes the configured
 * test command a real gate instead of a marker the patch could satisfy by accident.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(file) {
  return readFile(path.join(root, "src", file), "utf8");
}

test("the support form keeps its fields, name and submit control", async () => {
  const home = await source("pages/Home.jsx");
  assert.match(home, /id="subject"/, "the subject field disappeared");
  assert.match(home, /id="support-email"[^>]*type="email"/, "the email field disappeared");
  assert.match(home, /<button type="submit">Send<\/button>/, "the submit button disappeared");
});

test("the activity table keeps its caption and column headers", async () => {
  const home = await source("pages/Home.jsx");
  assert.match(home, /<caption>Requests handled in the last hour<\/caption>/);
  assert.match(home, /<th scope="col">Agent<\/th>/);
});

test("the settings route keeps both notification options", async () => {
  const settings = await source("pages/Settings.jsx");
  assert.match(settings, /id="mentioned"/);
  assert.match(settings, /id="handover"/);
  assert.match(settings, /<legend>Email me when<\/legend>/);
});

test("no rule clips or scrolls the activity panel sideways", async () => {
  const css = await source("styles.css");
  const log = /\.log\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.doesNotMatch(log, /overflow(-x)?:\s*(hidden|scroll|auto)/, "the panel hides its own overflow instead of fitting");
  assert.doesNotMatch(css, /\.log\s*\{[^}]*white-space:\s*nowrap/, "the panel is forced not to wrap");
});

test("the stylesheet still styles the queue table", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.log table\s*\{/);
});
