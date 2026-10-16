import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./trusted-request";

/**
 * The control that keeps other machines out of the local-only write endpoints is the
 * bind address, not the `Host` header — a `Host` header is written by the client. These
 * tests pin the parts of that control that live in configuration, and the browser suite
 * additionally proves a real off-loopback connection is refused.
 */

const root = process.cwd();

function readPackageScripts(): Record<string, string> {
  const raw = readFileSync(path.join(root, "package.json"), "utf8");
  return (JSON.parse(raw) as { scripts: Record<string, string> }).scripts;
}

function readSource(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("loopback binding", () => {
  it("binds the dev and production servers to 127.0.0.1", () => {
    const scripts = readPackageScripts();
    expect(scripts.dev).toMatch(/-H\s+127\.0\.0\.1\b/);
    expect(scripts.start).toMatch(/-H\s+127\.0\.0\.1\b/);
  });

  it("binds the browser-suite server to loopback too", () => {
    // The e2e helper spawns `next start` directly, so it needs the same flag.
    const source = readSource(path.join("e2e", "support", "e2e-server.ts"));
    expect(source).toMatch(/"-H",\s*"127\.0\.0\.1"/);
  });

  it("does not silently enable remote baseline writes in any script", () => {
    const scripts = readPackageScripts();
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/UIPROOF_ALLOW_REMOTE_BASELINES/);
    }
  });

  it("keeps the header check stricter than the wildcard it used to accept", () => {
    // Regression guard for the Phase 3 audit: 0.0.0.0 used to count as loopback.
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("0.0.0.0:3000")).toBe(false);
  });
});
