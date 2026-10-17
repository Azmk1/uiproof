#!/usr/bin/env node
/**
 * The application the Phase 8 repair integration test points UIProof at.
 *
 * It is deliberately somebody else's code: UIProof did not write this page and has no
 * knowledge of what it renders. Views and assets are read from disk on every request, so
 * the tests can swap a file and see a real change on the next capture — and so a patch
 * applied inside the isolated sandbox is genuinely what the sandbox server serves.
 *
 *   node examples/repair-app/server.mjs                 → http://127.0.0.1:4180
 *   PORT=4199 node examples/repair-app/server.mjs
 *
 * Environment: PORT, HOST, EXAMPLE_APP_DIR.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.EXAMPLE_APP_DIR ? path.resolve(process.env.EXAMPLE_APP_DIR) : here;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4180);

const VIEWS = {
  "/": "views/index.html",
  "/manual": "views/manual.html",
};

const ASSETS = {
  "/assets/app.css": "text/css; charset=utf-8",
};

function send(response, status, body, contentType = "text/html; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (pathname === "/healthz") {
      return send(response, 200, JSON.stringify({ ok: true, routes: Object.keys(VIEWS) }), "application/json");
    }
    const view = VIEWS[pathname];
    if (view) {
      return send(response, 200, await readFile(path.join(root, view), "utf8"));
    }
    const assetType = ASSETS[pathname];
    if (assetType) {
      return send(response, 200, await readFile(path.join(root, pathname.slice(1)), "utf8"), assetType);
    }
    return send(response, 404, "<!doctype html><meta charset=\"utf-8\"><title>404</title><h1>Not found</h1>");
  } catch (error) {
    return send(response, 500, `<h1>500</h1><pre>${error instanceof Error ? error.message : String(error)}</pre>`);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`repair-app: listening on http://${host}:${port} (${root})\n`);
});
