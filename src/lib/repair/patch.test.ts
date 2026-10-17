import { describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import {
  applyPatch,
  checkPatchScope,
  matchesGlob,
  parsePatch,
  preparePatch,
  MAX_PATCH_FILES,
} from "./patch";

const SOURCE = [
  "<html>",
  "  <body>",
  '    <button class="ghost"><span aria-hidden="true">✎</span></button>',
  "  </body>",
  "</html>",
].join("\n");

function patchFor(oldLine: string, newLine: string, header = "@@ -3,1 +3,1 @@"): string {
  return [`--- a/views/page.html`, `+++ b/views/page.html`, header, `-${oldLine}`, `+${newLine}`].join("\n");
}

function codeOf(run: () => unknown): ComparisonError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComparisonError);
    return error as ComparisonError;
  }
  throw new Error("expected the call to throw");
}

describe("unified diff parsing", () => {
  it("parses and applies one replacement", () => {
    const patch = parsePatch(patchFor('    <button class="ghost"><span aria-hidden="true">✎</span></button>', '    <button class="ghost" aria-label="Edit"><span aria-hidden="true">✎</span></button>'));
    expect(patch.files).toHaveLength(1);
    expect(patch.additions).toBe(1);
    expect(patch.deletions).toBe(1);

    const applied = applyPatch(patch, new Map([["views/page.html", SOURCE]]));
    expect(applied.files.get("views/page.html")).toContain('aria-label="Edit"');
    expect(applied.changes).toEqual([{ path: "views/page.html", additions: 1, deletions: 1 }]);
  });

  it("applies several hunks and keeps the trailing newline", () => {
    const text = `${SOURCE}\n`;
    const patch = parsePatch(
      [
        "--- a/views/page.html",
        "+++ b/views/page.html",
        "@@ -1,2 +1,2 @@",
        " <html>",
        "-  <body>",
        "+  <body class=\"app\">",
        "@@ -4,2 +4,3 @@",
        "   </body>",
        "+  <p>Added</p>",
        " </html>",
      ].join("\n"),
    );
    const applied = applyPatch(patch, new Map([["views/page.html", text]]));
    expect(applied.files.get("views/page.html")).toBe(
      ["<html>", '  <body class="app">', '    <button class="ghost"><span aria-hidden="true">✎</span></button>', "  </body>", "  <p>Added</p>", "</html>", ""].join("\n"),
    );
  });

  it("accepts CRLF patch text and a pure insertion", () => {
    const patch = parsePatch(
      ["--- a/a.css", "+++ b/a.css", "@@ -0,0 +1,1 @@", "+body { color: #333; }"].join("\r\n"),
    );
    // An empty file has no trailing newline to preserve, so the inserted line is all there is.
    const applied = applyPatch(patch, new Map([["a.css", ""]]));
    expect(applied.files.get("a.css")).toBe("body { color: #333; }");
  });

  it("treats an empty diff line as an empty context line", () => {
    const patch = parsePatch(
      ["--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " const a = 1;", "", "-const b = 2;", "+const b = 3;"].join("\n"),
    );
    expect(applyPatch(patch, new Map([["a.ts", "const a = 1;\n\nconst b = 2;\n"]])).files.get("a.ts")).toBe(
      "const a = 1;\n\nconst b = 3;\n",
    );
  });

  it("refuses a context mismatch rather than fuzzing it", () => {
    const error = codeOf(() =>
      applyPatch(parsePatch(patchFor("  <body>", "  <body id=\"x\">")), new Map([["views/page.html", SOURCE]])),
    );
    expect(error.code).toBe("repair_patch_rejected");
    expect(error.message).toContain("does not match");
  });

  it("refuses traversal, absolutes, backslashes and renames", () => {
    const bad = [
      ["--- a/../secret.ts", "+++ b/../secret.ts", "@@ -1,1 +1,1 @@", "-a", "+b"],
      ["--- /etc/passwd", "+++ /etc/passwd", "@@ -1,1 +1,1 @@", "-a", "+b"],
      ["--- a/views\\page.html", "+++ b/views\\page.html", "@@ -1,1 +1,1 @@", "-a", "+b"],
      ["--- a/one.ts", "+++ b/two.ts", "@@ -1,1 +1,1 @@", "-a", "+b"],
      ["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,1 @@", "+a"],
      ["--- a/old.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-a"],
    ];
    for (const lines of bad) {
      const error = codeOf(() => parsePatch(lines.join("\n")));
      expect(error.code).toBe("repair_patch_rejected");
    }
  });

  it("refuses a hunk whose declared counts do not match its body", () => {
    const error = codeOf(() =>
      parsePatch(["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "-a", "+b"].join("\n")),
    );
    expect(error.message).toContain("declares 2 old line(s)");
  });

  it("refuses a no-op patch", () => {
    const error = codeOf(() =>
      applyPatch(
        parsePatch(["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 1;"].join("\n")),
        new Map([["a.ts", "const a = 1;\n"]]),
      ),
    );
    expect(error.message).toContain("would not change");
  });

  it("enforces the file-count limit as parsed", () => {
    const lines: string[] = [];
    for (let index = 0; index <= MAX_PATCH_FILES; index += 1) {
      lines.push(`--- a/f${index}.ts`, `+++ b/f${index}.ts`, "@@ -1,1 +1,1 @@", "-a", "+b");
    }
    const error = codeOf(() => parsePatch(lines.join("\n")));
    expect(error.code).toBe("repair_limits_exceeded");
  });
});

describe("patch scope", () => {
  const files = ["views/page.html", "assets/app.css", "uiproof.config.json", ".env", "package.json", "node_modules/x/index.js"];
  const one = (path: string) =>
    parsePatch([`--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"));

  it("accepts application source and a configured allow-list", () => {
    const result = checkPatchScope(one("views/page.html"), files);
    expect(result).toEqual({ ok: true, files: ["views/page.html"], violations: [] });
    expect(checkPatchScope(one("views/page.html"), files, ["views/**"]).ok).toBe(true);
    expect(checkPatchScope(one("assets/app.css"), files, ["views/**"]).ok).toBe(false);
  });

  it("refuses secrets, dependencies, CI policy, the registration and baselines", () => {
    const cases: Array<[string, string]> = [
      [".env", "hidden path"],
      ["package.json", "dependency manifest"],
      ["uiproof.config.json", "registration file"],
      ["node_modules/x/index.js", "dependency directory"],
      [".github/workflows/ci.yml", "hidden path"],
      ["uiproof-baselines/bundle.json", "approved-baseline store"],
      ["src/certificate.pem", "key material"],
    ];
    for (const [path, reason] of cases) {
      const result = checkPatchScope(one(path), [...files, path]);
      expect(result.ok).toBe(false);
      expect(result.violations[0].reason).toContain(reason);
    }
  });

  it("refuses a file the workspace never listed", () => {
    const result = checkPatchScope(one("src/unlisted.ts"), files);
    expect(result.ok).toBe(false);
    expect(result.violations[0].reason).toContain("not part of the registered source");
  });
});

describe("preparePatch", () => {
  it("throws a scope error before applying an unsafe patch", () => {
    const error = codeOf(() =>
      preparePatch({
        patch: ["--- a/package.json", "+++ b/package.json", "@@ -1,1 +1,1 @@", '-"a": 1', '+"a": 2'].join("\n"),
        files: new Map([["package.json", '{\n"a": 1\n}']]),
        knownFiles: ["package.json"],
      }),
    );
    expect(error.code).toBe("repair_scope_violation");
  });
});

describe("matchesGlob", () => {
  it("keeps * inside a segment and lets ** cross directories", () => {
    expect(matchesGlob("views/*.html", "views/page.html")).toBe(true);
    expect(matchesGlob("views/*.html", "views/nested/page.html")).toBe(false);
    expect(matchesGlob("views/**/*.html", "views/nested/page.html")).toBe(true);
    expect(matchesGlob("**/*.css", "assets/app.css")).toBe(true);
    expect(matchesGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchesGlob("src/**", "lib/a.ts")).toBe(false);
  });
});
