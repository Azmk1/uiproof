#!/usr/bin/env node
/**
 * The example application UIProof is pointed at in the Phase 3 integration test.
 *
 * It exists to be somebody else's code: UIProof did not write this server, does not
 * bundle it and does not know what it renders. It is deliberately tiny and has no
 * dependencies beyond Node itself, so a reviewer can read all of it in a minute.
 *
 *   node examples/example-app/server.mjs          → http://127.0.0.1:4173
 *   PORT=4273 node examples/example-app/server.mjs
 *
 * Environment:
 *   PORT             port to listen on (default 4173)
 *   HOST             interface to bind (default 127.0.0.1)
 *   EXAMPLE_APP_DIR  directory holding `views/` and `assets/` (default this folder)
 *
 * Two deliberate properties, both needed by the integration test:
 *  · Views and assets are read from disk on every request, so editing a view is a real
 *    change to what the application renders and shows up on the next request — no
 *    restart, no build step.
 *  · `/moved` answers with a 302 to a public origin. A capture of it must be refused,
 *    because the page would leave the registered loopback origin.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.EXAMPLE_APP_DIR ? path.resolve(process.env.EXAMPLE_APP_DIR) : here;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4173);

/** Route → view file. These are the pages a developer registers with UIProof. */
const VIEWS = {
  "/": "views/home.html",
  "/settings": "views/settings.html",
  "/pricing": "views/pricing.html",
  "/embedded": "views/embedded.html",
  "/support": "views/quality.html",
};

const ASSETS = {
  "/assets/app.css": "text/css; charset=utf-8",
};

/** Ends up on a public origin: unapproved, so a capture of it must fail loudly. */
const REDIRECTS = {
  "/moved": "https://example.com/",
};

function send(response, status, body, contentType = "text/html; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    // No caching anywhere: a capture must see the page as it is right now.
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

    const redirect = REDIRECTS[pathname];
    if (redirect) {
      response.writeHead(302, { location: redirect, "cache-control": "no-store" });
      return response.end();
    }

    const view = VIEWS[pathname];
    if (view) {
      // Read per request: editing a view is a change to what this app renders.
      return send(response, 200, await readFile(path.join(root, view), "utf8"));
    }

    const assetType = ASSETS[pathname];
    if (assetType) {
      return send(response, 200, await readFile(path.join(root, pathname.slice(1)), "utf8"), assetType);
    }

    return send(response, 404, "<!doctype html><meta charset=\"utf-8\"><title>404</title><h1>Not found</h1>");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return send(response, 500, `<h1>500</h1><pre>${message}</pre>`);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`example-app: listening on http://${host}:${port} (${root})\n`);
});
