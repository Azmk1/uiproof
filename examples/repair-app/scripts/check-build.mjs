#!/usr/bin/env node
/**
 * The fixture's "build": a real structural check of every view.
 *
 * It is not a marker grep — it parses tags and requires them to balance, so a patch that
 * deletes a closing tag genuinely fails the build and UIProof's verification says so.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewsDir = path.join(root, "views");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

for (const name of await readdir(viewsDir)) {
  if (!name.endsWith(".html")) continue;
  const html = await readFile(path.join(viewsDir, name), "utf8");
  const stack = [];
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g)) {
    const tag = match[1].toLowerCase();
    if (VOID.has(tag)) continue;
    if (match[0].startsWith("</")) {
      const open = stack.pop();
      if (open !== tag) {
        console.error(`${name}: expected </${open ?? "(nothing)"}> but found </${tag}>`);
        process.exit(1);
      }
    } else {
      stack.push(tag);
    }
  }
  if (stack.length > 0) {
    console.error(`${name}: unclosed tag(s): ${stack.join(", ")}`);
    process.exit(1);
  }
  if (!/<\/html>\s*$/.test(html)) {
    console.error(`${name}: does not end with </html>`);
    process.exit(1);
  }
}

console.log("build: every view is structurally balanced");
