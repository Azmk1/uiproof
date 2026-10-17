import { realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import { MAX_FILE_BYTES, openWorkspace, type Workspace } from "./workspace";
import { makeTree, removeTree } from "./test-temp";

/**
 * The workspace is the only code in UIProof that reads a developer's application, so these
 * tests are about what it refuses as much as what it returns: dependencies, build output,
 * hidden files, credentials, symlinks, oversize files, and paths it never listed.
 */

const ROOTS: string[] = [];

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await makeTree(files);
  ROOTS.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map(removeTree));
});

function reasonFor(workspace: Workspace, relativePath: string): string | undefined {
  return workspace.skipped.find((entry) => entry.path === relativePath)?.reason;
}

describe("openWorkspace", () => {
  it("lists the application's own source with stable, forward-slashed paths", async () => {
    const root = await tree({
      "src/app/settings/page.tsx": "export default function Page() { return <div />; }\n",
      "src/components/form.tsx": "export const Form = () => null;\n",
      "styles/app.css": ".promo { width: 720px; }\n",
      "README.md": "not source, but not an application file UIProof reads\n",
      "public/index.html": "<html><body></body></html>\n",
    });

    const workspace = await openWorkspace(root);
    const paths = workspace.files.map((file) => file.relativePath).sort();

    expect(paths).toEqual([
      "public/index.html",
      "src/app/settings/page.tsx",
      "src/components/form.tsx",
      "styles/app.css",
    ]);
    expect(paths.every((entry) => !entry.includes("\\"))).toBe(true);
    expect(workspace.root).toBe(await realpath(root));
    expect(workspace.files.find((file) => file.relativePath === "src/app/settings/page.tsx")?.lines).toBe(2);
  });

  it("never reads dependencies, build output, hidden files or credentials", async () => {
    const root = await tree({
      "src/app/page.tsx": "export default () => null;\n",
      "node_modules/react/index.js": "module.exports = {};\n",
      "dist/app.js": "console.log(1);\n",
      ".next/server/page.js": "console.log(1);\n",
      "coverage/report.html": "<html></html>\n",
      ".git/config": "[core]\n",
      ".uiproof/runs/a.json": "{}\n",
      ".env": "OPENAI_API_KEY=sk-should-never-be-read\n",
      ".env.local": "SECRET=1\n",
      ".npmrc": "//registry:_authToken=abc\n",
      "src/id_rsa": "-----BEGIN PRIVATE KEY-----\n",
      "src/server-secret.ts": "export const secret = 'x';\n",
      "src/model.pem": "-----BEGIN PRIVATE KEY-----\n",
      "src/app.min.js": "var a=1;\n",
      "src/app.min.css": "a{color:red}\n",
      "package-lock.json": "{}\n",
      "scripts/deploy": "#!/bin/sh\n",
      "public/logo.png": "not really a png\n",
    });

    const workspace = await openWorkspace(root);
    expect(workspace.files.map((file) => file.relativePath)).toEqual(["src/app/page.tsx"]);

    expect(reasonFor(workspace, "node_modules")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, "dist")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, ".next")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, "coverage")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, ".git")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, ".uiproof")).toContain("generated, dependency or hidden directory");
    expect(reasonFor(workspace, ".env")).toContain("hidden file");
    expect(reasonFor(workspace, ".env.local")).toContain("hidden file");
    expect(reasonFor(workspace, "src/server-secret.ts")).toContain("credential, log or generated");
    expect(reasonFor(workspace, "src/model.pem")).toContain("credential, log or generated");
    expect(reasonFor(workspace, "src/app.min.js")).toContain("credential, log or generated");
    expect(reasonFor(workspace, "scripts/deploy")).toContain("no file extension");
    expect(reasonFor(workspace, "package-lock.json")).toContain("outside the investigated set");
    expect(reasonFor(workspace, "public/logo.png")).toContain("outside the investigated set");
  });

  it("skips a file larger than the read cap instead of truncating it silently", async () => {
    const root = await tree({
      "src/small.ts": "export const small = 1;\n",
      "src/huge.ts": `// ${"x".repeat(MAX_FILE_BYTES)}\n`,
    });

    const workspace = await openWorkspace(root);
    expect(workspace.files.map((file) => file.relativePath)).toEqual(["src/small.ts"]);
    expect(reasonFor(workspace, "src/huge.ts")).toBe(`larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB`);
  });

  it("resolves a relative root against the caller's directory", async () => {
    const root = await tree({ "app/pages/index.vue": "<template><div /></template>\n" });
    const workspace = await openWorkspace("app", root);
    expect(workspace.root).toBe(await realpath(path.join(root, "app")));
    expect(workspace.files.map((file) => file.relativePath)).toEqual(["pages/index.vue"]);
  });

  it("refuses a missing directory, a file and an empty path", async () => {
    const root = await tree({ "src/index.ts": "export {};\n" });
    const cases = [
      { input: path.join(root, "does-not-exist"), message: /could not be read/ },
      { input: path.join(root, "src/index.ts"), message: /not a directory/ },
      { input: "   ", message: /A source directory is required/ },
      { input: undefined, message: /A source directory is required/ },
    ];

    for (const entry of cases) {
      const error = await openWorkspace(entry.input).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(ComparisonError);
      expect((error as ComparisonError).code).toBe("diagnosis_source_invalid");
      expect((error as ComparisonError).message).toMatch(entry.message);
    }
  });

  it("never follows a link to a directory outside the root", async () => {
    const outside = await tree({ "elsewhere/secret.ts": "export const token = 'x';\n" });
    const root = await tree({ "src/view.ts": "export const view = 1;\n" });
    // A junction is the one link Windows can create without elevation; it is still a
    // reparse point, and the walk must treat it exactly like a POSIX directory symlink.
    await symlink(path.join(outside, "elsewhere"), path.join(root, "vendor-link"), process.platform === "win32" ? "junction" : "dir");

    const workspace = await openWorkspace(root);
    expect(workspace.files.map((file) => file.relativePath)).toEqual(["src/view.ts"]);
    expect(reasonFor(workspace, "vendor-link")).toBe("symbolic link (never followed)");
  });

  it("never follows a file symlink, including one created after the listing", async ({ skip }) => {
    const outside = await tree({ "elsewhere/secret.ts": "export const token = 'x';\n" });
    const root = await tree({ "src/view.ts": "export const view = 1;\n" });

    try {
      await symlink(path.join(outside, "elsewhere/secret.ts"), path.join(root, "src/linked.ts"), "file");
    } catch {
      // Creating a file symlink needs Developer Mode or elevation on Windows.
      skip();
      return;
    }

    const workspace = await openWorkspace(root);
    expect(workspace.files.map((file) => file.relativePath)).toEqual(["src/view.ts"]);
    expect(reasonFor(workspace, "src/linked.ts")).toContain("symbolic link");
  });
});

describe("workspace.read", () => {
  it("returns the file's text", async () => {
    const root = await tree({ "src/greeting.ts": "export const greeting = 'hello';\n" });
    const workspace = await openWorkspace(root);
    const file = workspace.files[0];
    expect(await workspace.read(file)).toBe("export const greeting = 'hello';\n");
  });

  it("refuses a path the walk never listed", async () => {
    const root = await tree({ "src/greeting.ts": "export const greeting = 'hello';\n" });
    const workspace = await openWorkspace(root);

    await expect(
      workspace.read({
        relativePath: "../../etc/passwd",
        absolutePath: "/etc/passwd",
        bytes: 10,
        lines: 1,
      }),
    ).rejects.toThrow(/Refusing to read a file that was not listed in the workspace/);
  });
});
