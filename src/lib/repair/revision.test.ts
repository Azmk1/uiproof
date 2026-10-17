import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStaleSources, digestFileMap } from "./revision";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "uiproof-revision-"));
  dirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

describe("digestFileMap", () => {
  it("is deterministic and changes when bytes or paths change", () => {
    const a = digestFileMap(new Map([["b.html", "two"], ["a.css", "one"]]));
    const b = digestFileMap(new Map([["a.css", "one"], ["b.html", "two"]]));
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestFileMap(new Map([["a.css", "one!"], ["b.html", "two"]])).digest).not.toBe(a.digest);
    expect(digestFileMap(new Map([["renamed.css", "one"], ["b.html", "two"]])).digest).not.toBe(a.digest);
  });
});

describe("detectStaleSources", () => {
  it("reports unchanged, changed and missing files separately", async () => {
    const root = await tree({
      "views/index.html": "<html>one</html>",
      "views/other.html": "<html>other</html>",
      "assets/app.css": "body {}",
    });
    const snapshot = { "views/index.html": "a".repeat(64) };
    const result = await detectStaleSources(root, snapshot);
    expect(result.checked).toBe(1);
    expect(result.stale).toEqual(["views/index.html"]);

    const map = digestFileMap(new Map([["views/index.html", "<html>one</html>"]]));
    const current = await detectStaleSources(root, { "views/index.html": map.files.get("views/index.html")! });
    expect(current).toEqual({ checked: 1, stale: [], missing: [], reason: null });

    const gone = await detectStaleSources(root, { "views/index.html": "x", "views/deleted.html": "y" });
    expect(gone.stale).toEqual(["views/index.html"]);
    expect(gone.missing).toEqual(["views/deleted.html"]);
  });

  it("reports every reference stale when the directory is gone", async () => {
    const root = await tree({ "a.html": "x" });
    await rm(root, { recursive: true, force: true });
    const result = await detectStaleSources(root, { "a.html": "hash" });
    expect(result.stale).toEqual(["a.html"]);
    expect(result.reason).toMatch(/no longer readable/);
  });

  it("does nothing when there is no snapshot", async () => {
    expect(await detectStaleSources("/does/not/matter", {})).toEqual({
      checked: 0,
      stale: [],
      missing: [],
      reason: null,
    });
  });
});
