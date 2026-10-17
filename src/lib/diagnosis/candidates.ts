import type { DiagnosticIssue, SourceCandidate } from "./types";
import type { Workspace, WorkspaceFile } from "./workspace";

/**
 * Finds the application files a measured issue most plausibly lives in.
 *
 * Everything here is a **hypothesis about where to look**, and the module says so: it
 * ranks files by evidence that a browser can actually see — the route that was captured,
 * the selector and markup axe reported, and the literal text on the page — and it records
 * the reason for every file it selects. It never claims a file *causes* a defect, and it
 * never invents a path: a file is a candidate because a string the page produced appears in
 * it, at a line number this module counted.
 *
 * The excerpts are what a model gets to see, which is why they are bounded, numbered and
 * excluded from nothing the workspace already refused.
 */

export const DEFAULT_MAX_CANDIDATE_FILES = 4;
export const DEFAULT_EXCERPT_LINES = 30;
export const MAX_TOKENS_PER_ISSUE = 12;
export const MAX_EXCERPT_LINE_CHARS = 300;

/**
 * How much each kind of evidence counts. The route is a weak prior — a page file is a
 * guess that the element lives there — while a string the browser reported is proof that
 * this file rendered it. A phrase of visible text is the strongest signal of all, because
 * prose from the rendered DOM rarely appears anywhere but where it is written.
 */
const ROUTE_WEIGHTS = { page: 45, layout: 28, component: 22, directory: 18, pathMention: 14 } as const;
const TOKEN_WEIGHTS = { selector: 30, attribute: 22, markup: 18, text: 40 } as const;

/**
 * When an issue carries the element's markup, a file that can render markup is a better home
 * for it than a stylesheet that merely mentions its class: an icon-only button's missing name
 * lives in the template, not in `.ghost { … }`.
 */
const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".tsx", ".jsx", ".vue", ".svelte", ".astro"]);
const MARKUP_WEIGHT = 8;

/** Element/attribute names that would match half a codebase and mean nothing. */
const GENERIC_TOKENS = new Set([
  "html", "body", "head", "main", "div", "span", "section", "header", "footer", "nav", "aside",
  "button", "input", "select", "option", "label", "form", "fieldset", "legend", "table", "thead",
  "tbody", "tr", "td", "th", "caption", "ul", "ol", "li", "a", "p", "strong", "em", "code", "pre",
  "img", "svg", "path", "g", "text", "h1", "h2", "h3", "h4", "h5", "h6", "true", "false", "none",
  "auto", "button-primary", "button-secondary", "hidden", "undefined", "string", "number",
]);

export interface SearchToken {
  readonly value: string;
  /** How the token was found — shown to the model and to a reviewer. */
  readonly from: "selector" | "markup" | "text" | "attribute";
  /** Text tokens are matched as literal phrases; identifiers as substrings. */
  readonly kind: "identifier" | "phrase";
}

function pathExtension(relativePath: string): string {
  const index = relativePath.lastIndexOf(".");
  return index === -1 ? "" : relativePath.slice(index).toLowerCase();
}

function pushToken(tokens: SearchToken[], seen: Set<string>, token: SearchToken): void {
  const key = `${token.kind}:${token.value}`;
  const lowered = token.value.toLowerCase();
  if (token.value.length < 3 || GENERIC_TOKENS.has(lowered)) return;
  if (seen.has(key)) return;
  if (tokens.length >= MAX_TOKENS_PER_ISSUE) return;
  seen.add(key);
  tokens.push(token);
}

/**
 * Extracts what can safely be searched for from an issue's own measurement: the selector
 * axe reported, the element's markup, and the visible words inside it.
 */
export function tokensFromIssue(issue: DiagnosticIssue): SearchToken[] {
  const tokens: SearchToken[] = [];
  const seen = new Set<string>();
  const selector = issue.hints?.selector ?? "";
  const html = issue.hints?.html ?? "";

  for (const match of selector.matchAll(/[#.]([A-Za-z][\w-]*)/g)) {
    pushToken(tokens, seen, { value: match[1], from: "selector", kind: "identifier" });
  }
  for (const match of selector.matchAll(/\[([A-Za-z-]+)=["']?([^"'\]]+)["']?\]/g)) {
    pushToken(tokens, seen, { value: match[2], from: "attribute", kind: "identifier" });
  }

  for (const match of html.matchAll(/(?:id|class|for|name|data-[\w-]+|aria-[\w-]+)=["']([^"']+)["']/g)) {
    for (const part of match[1].split(/\s+/)) {
      if (part.includes("[") || part.includes("{")) continue;
      pushToken(tokens, seen, { value: part, from: "markup", kind: "identifier" });
    }
  }

  // Attribute *names* are evidence too, and often the most distinctive kind: an element
  // that hides its only content with `aria-hidden` is telling us which template rendered
  // it, even though the value (`"true"`) is meaningless as a search token.
  for (const match of html.matchAll(/([a-z][\w-]*)=["']/gi)) {
    const name = match[1].toLowerCase();
    if (name === "role" || name.startsWith("aria-") || name.startsWith("data-")) {
      pushToken(tokens, seen, { value: name, from: "attribute", kind: "identifier" });
    }
  }

  // The visible words of the element, when there are enough of them to be a real phrase.
  const inner = html.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  if (inner.length >= 12) {
    pushToken(tokens, seen, { value: inner.slice(0, 120), from: "text", kind: "phrase" });
  }

  return tokens;
}

/** Route segments a captured path decomposes into. `/` yields an empty list. */
export function routeSegments(route: string | null): string[] {
  if (!route) return [];
  return route.split("?")[0].split("#")[0].split("/").filter((segment) => segment.length > 0);
}

function segmentMatches(fileSegment: string, routeSegment: string): boolean {
  if (fileSegment === routeSegment) return true;
  // Next.js/Astro dynamic segments (`[id]`, `[...slug]`) render the captured path.
  return fileSegment.startsWith("[");
}

function routeScore(relativePath: string, segments: readonly string[]): { score: number; via: string[] } | null {
  const parts = relativePath.split("/");
  const roots = ["app", "src/app", "pages", "src/pages", "routes", "src/routes"];
  const pageNames = ["page.tsx", "page.jsx", "page.ts", "page.js", "index.tsx", "index.jsx", "index.ts", "index.js"];
  const file = parts[parts.length - 1];

  for (const root of roots) {
    const rootParts = root.split("/");
    if (parts.length < rootParts.length + 1) continue;
    if (!rootParts.every((part, index) => parts[index] === part)) continue;
    const directory = parts.slice(rootParts.length, parts.length - 1);

    if (segments.length === 0) {
      // The route `/` is the root page of its router directory.
      if (directory.length === 0 && pageNames.includes(file)) {
        return { score: ROUTE_WEIGHTS.page, via: [`root page file of the ${root} router`] };
      }
      if (directory.length === 0 && (file === "layout.tsx" || file === "layout.ts" || file === "layout.jsx")) {
        return { score: ROUTE_WEIGHTS.layout, via: [`root layout of the ${root} router`] };
      }
      continue;
    }

    if (directory.length === segments.length && directory.every((part, index) => segmentMatches(part, segments[index]))) {
      if (pageNames.includes(file)) {
        return { score: ROUTE_WEIGHTS.page, via: [`route page file for ${segments.map((s) => `/${s}`).join("")}`] };
      }
      if (/^layout\.(tsx|ts|jsx|js)$/.test(file)) {
        return { score: ROUTE_WEIGHTS.layout, via: [`layout wrapping ${segments.map((s) => `/${s}`).join("")}`] };
      }
      if (/\.(tsx|ts|jsx|js|css|scss|vue|svelte|html)$/.test(file)) {
        return { score: ROUTE_WEIGHTS.component, via: [`component beside the ${segments.map((s) => `/${s}`).join("")} route`] };
      }
    }

    const first = directory[0];
    if (first && segments[0] && segmentMatches(first, segments[0])) {
      return { score: ROUTE_WEIGHTS.directory, via: [`inside the ${root}/${segments[0]} route directory`] };
    }
  }

  // Generic fallback: the path mentions the route's own words.
  const lowered = relativePath.toLowerCase();
  const hit = segments.filter((segment) => lowered.includes(segment.toLowerCase()));
  if (hit.length === segments.length && segments.length > 0) {
    return { score: ROUTE_WEIGHTS.pathMention, via: [`path mentions ${hit.join(" and ")}`] };
  }
  return null;
}

interface TokenHit {
  readonly token: SearchToken;
  readonly lines: number[];
}

/**
 * Marks lines that are comments.
 *
 * A comment can name the very selector or sentence a defect is about — the example app's own
 * defective view documents `#support-email lost its <label>` in an HTML comment above the code.
 * Treating that line as a match would point the model (and the reader) at prose instead of the
 * element, so comments are never reported as matches or turned into an excerpt's centre. This is
 * a line-level approximation, not a parser: block comments are tracked across lines and a line
 * whose content begins with a comment marker is skipped.
 */
function commentMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let block: "html" | "css" | null = null;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    mask[index] = block !== null || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--");

    let cursor = 0;
    while (cursor < line.length) {
      if (block === null) {
        const html = line.indexOf("<!--", cursor);
        const css = line.indexOf("/*", cursor);
        if (html === -1 && css === -1) break;
        if (html !== -1 && (css === -1 || html < css)) {
          block = "html";
          cursor = html + 4;
        } else {
          block = "css";
          cursor = css + 2;
        }
        continue;
      }
      const closer = block;
      const end = closer === "html" ? line.indexOf("-->", cursor) : line.indexOf("*/", cursor);
      if (end === -1) break;
      block = null;
      cursor = end + (closer === "html" ? 3 : 2);
    }
  }
  return mask;
}

function findTokenLines(lines: readonly string[], token: SearchToken, comments: readonly boolean[]): number[] {
  const hits: number[] = [];
  const needle = token.kind === "phrase" ? token.value : token.value;
  for (const [index, line] of lines.entries()) {
    if (comments[index]) continue;
    const matched =
      token.kind === "phrase" ? line.includes(needle) : line.toLowerCase().includes(needle.toLowerCase());
    if (matched) hits.push(index + 1);
    if (hits.length >= 8) break;
  }
  return hits;
}

function buildExcerpt(
  lines: readonly string[],
  bestLine: number,
  excerptLines: number,
): { excerpt: string; startLine: number; endLine: number; truncated: boolean } {
  const total = lines.length;
  const before = Math.floor(excerptLines / 3);
  const end = Math.min(total, Math.max(1, bestLine - before) + excerptLines - 1);
  const start = Math.max(1, end - excerptLines + 1);

  const rendered: string[] = [];
  for (let line = start; line <= end; line += 1) {
    const text = lines[line - 1].replace(/\t/g, "  ");
    rendered.push(`${line}: ${text.length > MAX_EXCERPT_LINE_CHARS ? `${text.slice(0, MAX_EXCERPT_LINE_CHARS)}…` : text}`);
  }
  return {
    excerpt: rendered.join("\n"),
    startLine: start,
    endLine: end,
    truncated: total > excerptLines,
  };
}

export interface CandidateSearchOptions {
  readonly maxFiles?: number;
  readonly excerptLines?: number;
}

export interface CandidateSearchResult {
  /** Candidates per issue key, in rank order. */
  readonly byIssue: ReadonlyMap<string, readonly SourceCandidate[]>;
  /** Files actually read (relative paths), for the record. */
  readonly filesRead: readonly string[];
}

/**
 * Ranks files for every issue and reads the excerpts.
 *
 * Reading is the only I/O here and goes through the workspace's guarded `read`, so a file
 * that changed under us is refused rather than silently re-read from outside the root.
 */
export async function findCandidates(
  workspace: Workspace,
  issues: readonly DiagnosticIssue[],
  route: string | null,
  options: CandidateSearchOptions = {},
): Promise<CandidateSearchResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_CANDIDATE_FILES;
  const excerptLines = options.excerptLines ?? DEFAULT_EXCERPT_LINES;
  const segments = routeSegments(route);

  // One pass over the workspace text: every file is read at most once, and only files that
  // score above zero are read at all.
  const contents = new Map<string, { lines: string[]; comments: boolean[] }>();
  const readLines = async (file: WorkspaceFile): Promise<{ lines: string[]; comments: boolean[] }> => {
    const cached = contents.get(file.relativePath);
    if (cached) return cached;
    const text = await workspace.read(file);
    const lines = text.split("\n");
    const parsed = { lines, comments: commentMask(lines) };
    contents.set(file.relativePath, parsed);
    return parsed;
  };

  const byIssue = new Map<string, readonly SourceCandidate[]>();
  const filesRead = new Set<string>();

  for (const issue of issues) {
    const tokens = tokensFromIssue(issue);
    interface Scored {
      file: WorkspaceFile;
      score: number;
      via: string[];
      hits: TokenHit[];
    }
    const scored: Scored[] = [];

    // Pass 1: find what each file matches, without scoring yet. The score depends on how
    // common a token is across the workspace, and that can only be known once every file
    // that matches has been seen.
    const matches: Array<{
      file: WorkspaceFile;
      routeScore: number;
      routeVia: string[];
      markup: boolean;
      hits: TokenHit[];
    }> = [];

    for (const file of workspace.files) {
      const routeMatch = routeScore(file.relativePath, segments);
      if (routeMatch === null && tokens.length === 0) continue;

      const hits: TokenHit[] = [];
      const markup =
        (issue.hints?.html ?? "").length > 0 && MARKUP_EXTENSIONS.has(pathExtension(file.relativePath));

      if (tokens.length > 0) {
        // Read the file only when there is something to look for in it.
        let parsed: { lines: string[]; comments: boolean[] };
        try {
          parsed = await readLines(file);
        } catch {
          continue;
        }
        for (const token of tokens) {
          const tokenLines = findTokenLines(parsed.lines, token, parsed.comments);
          if (tokenLines.length === 0) continue;
          hits.push({ token, lines: tokenLines });
        }
        if (hits.length === 0 && !routeMatch) continue;
      }

      matches.push({
        file,
        routeScore: routeMatch?.score ?? 0,
        routeVia: routeMatch ? [...routeMatch.via] : [],
        markup,
        hits,
      });
    }

    // How many files a token appears in. A class name a dozen templates share is weak
    // evidence; an `aria-hidden` that appears in one file is strong evidence. Weighting by
    // this is what keeps a plausible-looking shared class from outranking the file that
    // actually rendered the element the browser reported.
    const documentFrequency = new Map<string, number>();
    for (const entry of matches) {
      for (const hit of entry.hits) {
        const key = `${hit.token.kind}:${hit.token.value}`;
        documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
      }
    }

    for (const entry of matches) {
      const via = [...entry.routeVia];
      let score = entry.routeScore;
      if (entry.markup) {
        score += MARKUP_WEIGHT;
        via.push("can render markup, so it may contain the element itself");
      }
      for (const hit of entry.hits) {
        const frequency = documentFrequency.get(`${hit.token.kind}:${hit.token.value}`) ?? 1;
        const distinctiveness = 1 / (1 + Math.log2(frequency));
        score += TOKEN_WEIGHTS[hit.token.from] * distinctiveness;
        const shared = frequency > 1 ? `, also in ${frequency - 1} other file(s)` : ", unique to this file";
        via.push(
          hit.token.from === "text"
            ? `contains the page text “${hit.token.value.slice(0, 60)}” (line ${hit.lines[0]}${shared})`
            : `contains ${hit.token.from === "selector" ? "the selector" : "the element's"} token "${hit.token.value}" (line ${hit.lines[0]}${shared})`,
        );
      }
      if (score <= 0) continue;
      scored.push({ file: entry.file, score, via, hits: entry.hits });
    }

    scored.sort((left, right) => (right.score - left.score) || (left.file.relativePath < right.file.relativePath ? -1 : 1));
    const candidates: SourceCandidate[] = [];

    for (const entry of scored.slice(0, maxFiles)) {
      let cached = contents.get(entry.file.relativePath);
      if (!cached) {
        try {
          cached = await readLines(entry.file);
        } catch {
          continue;
        }
      }
      const { lines } = cached;
      const matchedLines = [...new Set(entry.hits.flatMap((hit) => hit.lines))].sort((a, b) => a - b);
      const bestLine = entry.hits.length > 0 ? entry.hits[0].lines[0] : 1;
      const { excerpt, startLine, endLine, truncated } = buildExcerpt(lines, bestLine, excerptLines);
      filesRead.add(entry.file.relativePath);
      candidates.push({
        path: entry.file.relativePath,
        via: [...new Set(entry.via)],
        matchedLines,
        excerptStartLine: startLine,
        excerptEndLine: endLine,
        excerpt,
        excerptTruncated: truncated,
      });
    }

    byIssue.set(issue.key, candidates);
  }

  return { byIssue, filesRead: [...filesRead].sort() };
}
