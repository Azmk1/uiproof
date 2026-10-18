import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The fixture's own test command, run inside the repair sandbox before and after every
 * candidate. It holds invariants rather than asserting the defect, so a patch that deletes
 * the offending field or clips the table fails here instead of passing silently.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(file) {
  return readFile(path.join(root, file), "utf8");
}

test("the contact form keeps its fields and submit control", async () => {
  const page = await source("app/page.jsx");
  assert.match(page, /id="contact-subject"/);
  assert.match(page, /id="contact-email"[^>]*type="email"/);
  assert.match(page, /<button type="submit">Send message<\/button>/);
});

test("the transaction ledger keeps its caption and headers", async () => {
  const page = await source("app/page.jsx");
  assert.match(page, /<caption>Invoices raised this week<\/caption>/);
  assert.match(page, /<th scope="col">Status<\/th>/);
});

test("the settings route keeps both checkboxes", async () => {
  const settings = await source("app/settings/page.jsx");
  assert.match(settings, /id="monthly"/);
  assert.match(settings, /id="overdue"/);
  assert.match(settings, /<legend>Notify me<\/legend>/);
});

test("no rule clips or scrolls the ledger sideways", async () => {
  const css = await source("app/globals.css");
  const ledger = /\.ledger\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.doesNotMatch(ledger, /overflow(-x)?:\s*(hidden|scroll|auto)/, "the ledger hides its own overflow");
  assert.doesNotMatch(css, /\.ledger\s*\{[^}]*white-space:\s*nowrap/, "the ledger is forced not to wrap");
});

test("the layout still renders a navigation landmark", async () => {
  const layout = await source("app/layout.jsx");
  assert.match(layout, /<nav aria-label="Sections">/);
});
