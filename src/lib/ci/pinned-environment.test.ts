import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for the two things about CI that must never drift apart quietly.
 *
 * **The rendering environment.** A baseline is a screenshot, so a comparison only means
 * anything when both images came out of the same Chromium, the same fonts and the same
 * rasteriser. That environment is pinned in three places that have to agree: the exact
 * Playwright version in `package.json`, the container image in `scripts/ci/lib.sh`, and the
 * `container:` line of every workflow. Nothing else in the project would notice if one moved
 * without the others — the failure would show up as a baseline that mysteriously no longer
 * matches. This test notices.
 *
 * **The gate's honesty.** The defect these workflows were rewritten to remove was a "gate"
 * that approved the page it was about to test, which cannot fail. A grep for `--approve` or
 * `capture` in the gate workflow is a crude check, but it is the check that would have caught
 * the original bug, and the alternative — a screenshot of a green build — catches nothing.
 */

const root = process.cwd();
const workflowsDir = path.join(root, ".github", "workflows");

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function workflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/**
 * `playwright-core/browsers.json` holds the browser build Playwright downloads. pnpm keeps
 * dependencies where their dependant needs them rather than at the top level, so the path is
 * resolved through Playwright's own entry point instead of guessed.
 */
function browsersJsonPath(): string {
  const candidates: string[] = [];
  try {
    const entry = createRequire(import.meta.url).resolve("playwright");
    candidates.push(path.join(path.dirname(entry), "..", "playwright-core", "browsers.json"));
  } catch {
    /* fall through to the flat layout below */
  }
  candidates.push(path.join(root, "node_modules", "playwright-core", "browsers.json"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find playwright-core/browsers.json; tried ${candidates.join(", ")}`);
}

function pinFromLib(): { tag: string; digest: string; revision: string } {
  const source = read(path.join("scripts", "ci", "lib.sh"));
  const tag = /UIPROOF_IMAGE_TAG="([^"]+)"/.exec(source)?.[1];
  const digest = /UIPROOF_IMAGE_DIGEST="(sha256:[0-9a-f]{64})"/.exec(source)?.[1];
  const revision = /UIPROOF_CHROMIUM_REVISION="([0-9]+)"/.exec(source)?.[1];
  if (!tag || !digest || !revision) throw new Error("scripts/ci/lib.sh does not declare the pinned image");
  return { tag, digest, revision };
}

describe("the pinned rendering environment", () => {
  const pin = pinFromLib();

  it("pins the Playwright version exactly, with no range", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const version = manifest.dependencies.playwright;
    // A range would let a lockfile refresh move the browser out from under the image.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toMatch(/[\^~*><]/);
  });

  it("keeps the image tag in step with the Playwright dependency", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pin.tag).toBe(`v${manifest.dependencies.playwright}-noble`);
  });

  it("pins the image by tag and digest", () => {
    expect(pin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The tag carries the browser version; the digest is what actually cannot move.
    expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+-(noble|jammy)$/);
  });

  it("runs every workflow in that same image", () => {
    const images: Array<{ workflow: string; image: string }> = [];
    for (const name of workflowFiles()) {
      const source = read(path.join(".github", "workflows", name));
      for (const line of source.split("\n")) {
        const match = /^\s*image:\s*(\S+)\s*$/.exec(line);
        if (match) images.push({ workflow: name, image: match[1] });
      }
    }
    expect(images.length).toBeGreaterThan(0);
    for (const { workflow, image } of images) {
      expect(image, workflow).toBe(`mcr.microsoft.com/playwright:${pin.tag}@${pin.digest}`);
    }
  });

  it("records the Chromium revision the installed Playwright pins", () => {
    // If Playwright moves to a newer Chromium, the image tag and this revision move with it —
    // otherwise a committed baseline was rendered by a browser the gate no longer uses.
    const browsersJson = browsersJsonPath();
    const browsers = JSON.parse(readFileSync(browsersJson, "utf8")) as {
      browsers: Array<{ name: string; revision: string }>;
    };
    const chromium = browsers.browsers.find((browser) => browser.name === "chromium");
    expect(chromium, `${browsersJson} lists no chromium`).toBeDefined();
    expect(chromium!.revision).toBe(pin.revision);
  });
});

describe("the pull-request gate cannot approve what it is testing", () => {
  function gateWorkflows(): Array<{ name: string; source: string }> {
    return workflowFiles()
      .map((name) => ({ name, source: read(path.join(".github", "workflows", name)) }))
      .filter(({ name, source }) => name.includes("visual-regression") && !name.includes("demo") && source.includes("container:"));
  }

  it("has exactly one gate workflow", () => {
    const gate = gateWorkflows();
    expect(gate.map(({ name }) => name)).toEqual(["visual-regression.yml"]);
  });

  it("never captures or approves anything", () => {
    for (const { name, source } of gateWorkflows()) {
      // Comments explain the rule; the executable lines are what matter.
      const body = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(body, `${name} must not approve a baseline`).not.toMatch(/--approve/);
      expect(body, `${name} must not capture a baseline`).not.toMatch(/\bcapture\b/);
    }
  });

  it("loads its reference from a commit the pull request cannot write to", () => {
    const gate = gateWorkflows()[0].source;
    expect(gate).toMatch(/--from-ref/);
    expect(gate).toMatch(/pull_request\.base\.ref|base\.ref/);
    expect(gate).toMatch(/trusted-baseline\.sh/);
  });

  it("gives the job no more than read access to the repository", () => {
    const gate = gateWorkflows()[0].source;
    expect(gate).toMatch(/permissions:/);
    expect(gate).toMatch(/contents:\s*read/);
    expect(gate).not.toMatch(/contents:\s*write|write-all|pull-requests:\s*write/);
  });

  it("starts the application under test with a scrubbed environment", () => {
    // The gate hands off to scripts/ci/lib.sh, which uses `env -i`; that is the control that
    // keeps a repository secret out of a process built from a pull request.
    const lib = read(path.join("scripts", "ci", "lib.sh"));
    expect(lib).toMatch(/env -i/);
    expect(lib).toMatch(/only what a web application needs/i);
  });
});
