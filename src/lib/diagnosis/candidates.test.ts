import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCandidates, routeSegments, tokensFromIssue } from "./candidates";
import type { DiagnosticIssue } from "./types";
import { openWorkspace } from "./workspace";
import { makeTree, removeTree } from "./test-temp";

/**
 * Candidate selection is a hypothesis about *where* to look, so these tests check that the
 * hypothesis is grounded in strings the page actually produced — the route, the selector,
 * the markup, the visible text — and that every line number points at a line that really
 * contains the match. A plausible-looking file that matches nothing must not be selected.
 */

const SETTINGS_PAGE = `import { SettingsForm } from "../../components/settings-form";

export default function SettingsPage() {
  return (
    <main className="settings">
      <h1>Booking settings</h1>
      <SettingsForm />
    </main>
  );
}
`;

const SETTINGS_LAYOUT = `export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <section className="settings-layout">{children}</section>;
}
`;

const SETTINGS_FORM = `export function SettingsForm() {
  return (
    <form className="settings-form">
      <label htmlFor="booking-window">Booking window</label>
      <select
        id="booking-status"
        name="status"
        className="input"
      >
        <option value="all">All statuses</option>
      </select>
      <button type="submit" className="button-primary">Save</button>
    </form>
  );
}
`;

const HOME_PAGE = `export default function HomePage() {
  return <main className="home">Welcome</main>;
}
`;

const PROMO_COMPONENT = `export function Promo() {
  return (
    <div className="promo">Winter offer: a free tune-up with every seven-day hire.</div>
  );
}
`;

const PROMO_CSS = `.promo {
  width: 720px;
}
`;

const ROOTS: string[] = [];

async function project(): Promise<{ root: string; workspace: Awaited<ReturnType<typeof openWorkspace>>; files: Record<string, string> }> {
  const files: Record<string, string> = {
    "src/app/settings/page.tsx": SETTINGS_PAGE,
    "src/app/settings/layout.tsx": SETTINGS_LAYOUT,
    "src/app/home/page.tsx": HOME_PAGE,
    "src/components/settings-form.tsx": SETTINGS_FORM,
    "src/components/promo.tsx": PROMO_COMPONENT,
    "styles/app.css": PROMO_CSS,
  };
  const root = await makeTree(files);
  ROOTS.push(root);
  return { root, workspace: await openWorkspace(root), files };
}

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map(removeTree));
});

function lineOf(content: string, needle: string): number {
  const index = content.split("\n").findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`fixture does not contain ${needle}`);
  return index + 1;
}

const A11Y_ISSUE: DiagnosticIssue = {
  key: "a11y:select-name@#booking-status",
  kind: "accessibility",
  title: "select-name on #booking-status",
  measured: [{ label: "Rule", value: "select-name" }],
  evidence: [],
  hints: {
    selector: "#booking-status",
    html: '<select class="input" id="booking-status" name="status"><option value="all">All statuses</option></select>',
  },
};

const OVERFLOW_ISSUE: DiagnosticIssue = {
  key: "responsive:mobile",
  kind: "responsive",
  title: "Horizontal overflow at Mobile",
  measured: [{ label: "Document overflow", value: "348px" }],
  evidence: [],
  hints: {
    selector: "div.promo",
    html: '<div class="promo">Winter offer: a free tune-up with every seven-day hire.</div>',
  },
};

const ROUTE_ONLY_ISSUE: DiagnosticIssue = {
  key: "visual:regression",
  kind: "visual",
  title: "Visual regression",
  measured: [{ label: "Changed pixels", value: "54686" }],
  evidence: [],
};

describe("tokensFromIssue", () => {
  it("takes the selector, the markup's own attributes and the visible phrase", () => {
    const tokens = tokensFromIssue(A11Y_ISSUE);
    const values = tokens.map((token) => `${token.kind}:${token.value}`);

    expect(values).toContain("identifier:booking-status");
    expect(values).toContain("identifier:status");
    expect(values).toContain("phrase:All statuses");
    // "input" and "select" are element-level names that would match half a codebase.
    expect(values).not.toContain("identifier:input");
    expect(values).not.toContain("identifier:select");
    expect(tokens.every((token) => token.value.length >= 3)).toBe(true);
    expect(tokens.map((token) => token.from)).toContain("selector");
    expect(tokens.map((token) => token.from)).toContain("markup");
  });

  it("keeps the element's text as a phrase and drops generic element names", () => {
    const tokens = tokensFromIssue(OVERFLOW_ISSUE);
    const phrase = tokens.find((token) => token.kind === "phrase");
    expect(phrase?.value).toBe("Winter offer: a free tune-up with every seven-day hire.");
    expect(tokens.some((token) => token.value === "div")).toBe(false);
  });

  it("has no machine hints for an issue that came from pixels alone", () => {
    expect(tokensFromIssue(ROUTE_ONLY_ISSUE)).toEqual([]);
  });
});

describe("routeSegments", () => {
  it("splits a captured path and ignores its query and hash", () => {
    expect(routeSegments("/settings?tab=hours#top")).toEqual(["settings"]);
    expect(routeSegments("/")).toEqual([]);
    expect(routeSegments(null)).toEqual([]);
  });
});

describe("findCandidates", () => {
  it("selects the component that contains the reported selector, and points at the real line", async () => {
    const { workspace, files } = await project();
    const { byIssue, filesRead } = await findCandidates(workspace, [A11Y_ISSUE], "/settings");

    const candidates = byIssue.get(A11Y_ISSUE.key) ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].path).toBe("src/components/settings-form.tsx");

    const expectedLine = lineOf(files["src/components/settings-form.tsx"], 'id="booking-status"');
    expect(candidates[0].matchedLines).toContain(expectedLine);
    expect(candidates[0].excerpt).toContain(`${expectedLine}: `);
    expect(candidates[0].excerpt).toContain('id="booking-status"');
    expect(candidates[0].excerptStartLine).toBeLessThanOrEqual(expectedLine);
    expect(candidates[0].excerptEndLine).toBeGreaterThanOrEqual(expectedLine);
    expect(candidates[0].via.join(" ")).toContain("booking-status");
    expect(filesRead).toContain("src/components/settings-form.tsx");
  });

  it("only returns files that exist in the workspace, with line numbers that match their content", async () => {
    const { workspace, root, files } = await project();
    const { byIssue } = await findCandidates(workspace, [A11Y_ISSUE], "/settings");

    for (const candidate of byIssue.get(A11Y_ISSUE.key) ?? []) {
      expect(candidate.path.startsWith("..")).toBe(false);
      expect(path.isAbsolute(candidate.path)).toBe(false);
      const content = await readFile(path.join(root, candidate.path), "utf8");
      const lines = content.split("\n");
      for (const line of candidate.matchedLines) {
        expect(line).toBeGreaterThanOrEqual(1);
        expect(line).toBeLessThanOrEqual(lines.length);
        expect(files[candidate.path]).toBeDefined();
      }
      expect(candidate.excerptStartLine).toBeGreaterThanOrEqual(1);
      expect(candidate.excerptEndLine).toBeLessThanOrEqual(lines.length);
    }
  });

  it("prefers the component that renders the overflowing element over the stylesheet that mentions it", async () => {
    const { workspace } = await project();
    const { byIssue } = await findCandidates(workspace, [OVERFLOW_ISSUE], "/settings", { maxFiles: 6 });
    const paths = (byIssue.get(OVERFLOW_ISSUE.key) ?? []).map((candidate) => candidate.path);

    expect(paths).toContain("src/components/promo.tsx");
    expect(paths).toContain("styles/app.css");
    expect(paths.indexOf("src/components/promo.tsx")).toBeLessThan(paths.indexOf("styles/app.css"));
  });

  it("falls back to the route's own page when the issue carries no markup hints", async () => {
    const { workspace } = await project();
    const { byIssue } = await findCandidates(workspace, [ROUTE_ONLY_ISSUE], "/settings");
    const candidates = byIssue.get(ROUTE_ONLY_ISSUE.key) ?? [];

    expect(candidates[0].path).toBe("src/app/settings/page.tsx");
    expect(candidates[0].via.join(" ")).toContain("route page file");
    expect(candidates.map((candidate) => candidate.path)).toContain("src/app/settings/layout.tsx");
  });

  it("returns nothing at all when neither the route nor the hints match anything", async () => {
    const { workspace } = await project();
    const { byIssue, filesRead } = await findCandidates(workspace, [ROUTE_ONLY_ISSUE], "/checkout");
    expect(byIssue.get(ROUTE_ONLY_ISSUE.key)).toEqual([]);
    expect(filesRead).toEqual([]);
  });

  it("honours the file cap and the excerpt size", async () => {
    const { workspace } = await project();
    const { byIssue } = await findCandidates(workspace, [A11Y_ISSUE, OVERFLOW_ISSUE], "/settings", {
      maxFiles: 1,
      excerptLines: 6,
    });

    for (const issue of [A11Y_ISSUE, OVERFLOW_ISSUE]) {
      const candidates = byIssue.get(issue.key) ?? [];
      expect(candidates).toHaveLength(1);
      expect(candidates[0].excerpt.split("\n").length).toBeLessThanOrEqual(6);
      expect(candidates[0].excerptEndLine - candidates[0].excerptStartLine + 1).toBeLessThanOrEqual(6);
    }
  });

  it("prefers the template that renders an element over a stylesheet that mentions its class", async () => {
    const root = await makeTree({
      "views/page.html": '<form>\n  <button class="ghost" type="button"><span aria-hidden="true">✎</span></button>\n</form>\n',
      "assets/app.css": ".ghost {\n  color: #333;\n}\n",
    });
    ROOTS.push(root);
    const workspace = await openWorkspace(root);

    const issue: DiagnosticIssue = {
      key: "a11y:button-name@button.ghost",
      kind: "accessibility",
      title: "button-name on button.ghost",
      measured: [],
      evidence: [],
      hints: {
        selector: "button.ghost",
        html: '<button class="ghost" type="button"><span aria-hidden="true">✎</span></button>',
      },
    };
    const candidates = (await findCandidates(workspace, [issue], "/support")).byIssue.get(issue.key) ?? [];

    expect(candidates.map((candidate) => candidate.path)).toEqual(["views/page.html", "assets/app.css"]);
    expect(candidates[0].matchedLines).toEqual([2]);
    expect(candidates[0].via.join(" ")).toContain("can render markup");
  });

  it("does not present a comment that names the selector as the match", async () => {
    const commented = [
      "<!--",
      "  The email field lost its <label>; #support-email is the selector axe reports.",
      "-->",
      "<form>",
      '  <input id="support-email" type="email" />',
      "</form>",
      "",
    ].join("\n");
    const root = await makeTree({ "views/page.html": commented });
    ROOTS.push(root);
    const workspace = await openWorkspace(root);

    const issue: DiagnosticIssue = {
      key: "a11y:label@#support-email",
      kind: "accessibility",
      title: "label on #support-email",
      measured: [],
      evidence: [],
      hints: { selector: "#support-email", html: '<input id="support-email" type="email" />' },
    };
    const candidates = (await findCandidates(workspace, [issue], "/support")).byIssue.get(issue.key) ?? [];

    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchedLines).toEqual([5]);
    expect(candidates[0].via.join(" ")).toContain("line 5");
    expect(candidates[0].excerpt).toContain('5:   <input id="support-email" type="email" />');
  });

  it("ranks the template that rendered an icon-only button above one that merely shares its class", async () => {
    // The Phase 7 pilot's known miss: the button-name finding on an icon-only button was
    // cited to a different view that also has a `.ghost` button. A distinctive attribute
    // (`aria-hidden`) and its rarity across the workspace is what tells the two apart.
    const home = [
      "<header>",
      '  <button class="ghost" type="button">Export CSV</button>',
      "</header>",
      "",
    ].join("\n");
    const support = [
      "<form>",
      '  <button class="ghost" type="button">Send message</button>',
      '  <button class="ghost" type="button">',
      '    <span aria-hidden="true">✎</span>',
      "  </button>",
      "</form>",
      "",
    ].join("\n");
    const root = await makeTree({ "views/home.html": home, "views/quality.html": support });
    ROOTS.push(root);
    const workspace = await openWorkspace(root);

    const issue: DiagnosticIssue = {
      key: "a11y:button-name@button.ghost:nth-child(2)",
      kind: "accessibility",
      title: "button-name on the icon-only button",
      measured: [],
      evidence: [],
      hints: {
        selector: "form > button.ghost:nth-child(2)",
        html: '<button class="ghost" type="button"><span aria-hidden="true">✎</span></button>',
      },
    };
    const candidates = (await findCandidates(workspace, [issue], "/support")).byIssue.get(issue.key) ?? [];

    expect(candidates.map((candidate) => candidate.path)).toEqual(["views/quality.html", "views/home.html"]);
    expect(candidates[0].via.join(" ")).toContain("aria-hidden");
    expect(candidates[0].via.join(" ")).toContain("unique to this file");
    expect(candidates[0].matchedLines).toEqual([2, 3, 4]);
    expect(candidates[0].matchedLines).not.toContain(1);
  });

  it("marks an excerpt as truncated when the file is longer than what was sent", async () => {
    const { workspace } = await project();
    const { byIssue } = await findCandidates(workspace, [A11Y_ISSUE], "/settings", { excerptLines: 6 });
    const candidate = (byIssue.get(A11Y_ISSUE.key) ?? [])[0];
    expect(candidate.excerptTruncated).toBe(true);
  });
});
