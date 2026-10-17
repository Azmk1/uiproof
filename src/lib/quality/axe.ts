import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import axeRuntime from "axe-core";
import type { Page } from "playwright";
import { ComparisonError } from "@/lib/compare/errors";
import { fingerprintFinding } from "./fingerprint";
import type { AccessibilityFinding, AccessibilitySummary, AxeImpact } from "./types";

/**
 * The accessibility scanner: axe-core, run inside the page UIProof has already captured.
 *
 * It is deliberately the same page instance the screenshot came from, so a finding and a
 * pixel come from one rendering — not two browsers that might disagree.
 *
 * What this module refuses to do:
 *
 *  · **Report a clean scan it did not perform.** If the axe source is missing, the page
 *    injection fails or the runner throws, that is a `quality_unavailable` error and the
 *    command exits `2`. "No findings" is only ever published after a scan actually ran.
 *  · **Judge a result the runner left open.** axe's `incomplete` set (contrast it cannot
 *    compute, for example) is carried as `needs-review` and is never counted against a
 *    policy, because deciding those is a human's job.
 *  · **Summarise into a score.** There is no number here that stands in for the findings.
 *  · **Claim compliance.** The report says which rule set ran and which version of the
 *    runner produced it, which is what makes the result checkable — and is also why it
 *    cannot be read as a WCAG certificate.
 */

const MAX_FINDINGS_DEFAULT = 60;
const MAX_TEXT_LENGTH = 300;

/**
 * The rule set an audit runs. Naming it explicitly (rather than taking axe's defaults)
 * keeps two scans of the same page comparable across axe upgrades: a rule added to a newer
 * axe does not silently appear in — or disappear from — a report.
 */
export const AXE_RULE_SETS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
] as const;

const runtime = axeRuntime as unknown as { readonly version?: unknown; readonly source?: unknown };
export const AXE_VERSION = typeof runtime.version === "string" ? runtime.version : "unknown";

/**
 * The browser script to inject into the page under test.
 *
 * axe-core builds its `source` from `Function.prototype.toString()` of its own build.
 * That survives plain Node and simple bundling, but not a bundler that rewrites the
 * function in place: the string is no longer the library, the injection defines nothing
 * at all, and the scan would report "axe-core is not present in the page". So the file
 * shipped in `node_modules` is read first — it is always the real thing — and the runtime
 * value is only the fallback.
 */
function axeFileCandidates(): readonly string[] {
  const candidates: string[] = [];
  try {
    const requireFromHere = createRequire(import.meta.url);
    candidates.push(path.join(path.dirname(requireFromHere.resolve("axe-core")), "axe.min.js"));
  } catch {
    /* bundled or unresolvable here — the working directory is checked next */
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(path.join(dir, "node_modules", "axe-core", "axe.min.js"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function loadAxeSource(): string {
  for (const candidate of axeFileCandidates()) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      /* keep looking */
    }
  }
  return typeof runtime.source === "string" ? runtime.source : "";
}

const AXE_SOURCE = loadAxeSource();

export interface AccessibilityScanOptions {
  /** Cap on findings carried in the report; the full count is always reported too. */
  readonly maxFindings?: number;
}

/* ── defensive reading of the runner's payload ─────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function truncate(value: string, limit = MAX_TEXT_LENGTH): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

const IMPACTS: readonly string[] = ["minor", "moderate", "serious", "critical"];

/** Severity rank used to keep the most severe appearance of a fingerprint. */
function impactRank(impact: AxeImpact | null): number {
  return impact === null ? IMPACTS.length : IMPACTS.indexOf(impact);
}

function readImpact(value: unknown): AxeImpact | null {
  return typeof value === "string" && IMPACTS.includes(value) ? (value as AxeImpact) : null;
}

/** axe targets a node with a selector, or with an array of selectors inside a frame. */
function readSelector(value: unknown): string {
  const parts: string[] = [];
  for (const entry of readArray(value)) {
    if (typeof entry === "string") parts.push(entry);
    else if (Array.isArray(entry)) parts.push(entry.map((inner) => String(inner)).join(" >>> "));
  }
  return truncate(parts.join(" "), 240);
}

interface PageScanPayload {
  readonly violations: readonly unknown[];
  readonly incomplete: readonly unknown[];
  readonly passedRules: readonly string[];
  readonly nodeResults: number;
  readonly testEngine: string;
}

async function ensureAxe(page: Page): Promise<void> {
  if (AXE_SOURCE.length === 0) {
    throw new ComparisonError(
      "quality_unavailable",
      "axe-core did not expose its browser source, so the accessibility scan cannot run. Reinstall dependencies (`pnpm install`) and try again.",
    );
  }
  const loaded = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== "undefined");
  if (loaded) return;
  try {
    await page.addScriptTag({ content: AXE_SOURCE });
  } catch (cause) {
    throw new ComparisonError(
      "quality_unavailable",
      `axe-core could not be injected into the page: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  // Injection is only a script append: verify the library actually loaded rather than
  // letting a broken script pass silently and the scan blame the page for it.
  const present = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== "undefined");
  if (!present) {
    throw new ComparisonError(
      "quality_unavailable",
      "axe-core was injected but did not load in the page, so no accessibility scan was performed.",
    );
  }
}

/* ── the scan ──────────────────────────────────────────────────────────────────────────── */

export async function scanAccessibility(
  page: Page,
  options: AccessibilityScanOptions = {},
): Promise<AccessibilitySummary> {
  const maxFindings = options.maxFindings ?? MAX_FINDINGS_DEFAULT;
  await ensureAxe(page);

  let raw: PageScanPayload;
  try {
    raw = await page.evaluate(
      async (ruleSets: readonly string[]): Promise<PageScanPayload> => {
        const scope = window as unknown as {
          axe?: { run: (context: Document, options: unknown) => Promise<Record<string, unknown>> };
        };
        if (!scope.axe) throw new Error("axe-core is not present in the page");
        const results = await scope.axe.run(document, {
          runOnly: { type: "tag", values: ruleSets as string[] },
          resultTypes: ["violations", "incomplete", "passes"],
        });
        const collect = (key: string): unknown[] =>
          Array.isArray(results[key]) ? (results[key] as unknown[]) : [];
        const nodeCount = (groups: readonly unknown[][]): number => {
          let total = 0;
          for (const group of groups) {
            for (const entry of group) {
              const record = entry as { nodes?: unknown };
              const nodes: unknown = record?.nodes;
              if (Array.isArray(nodes)) total += nodes.length;
            }
          }
          return total;
        };
        const violations = collect("violations");
        const incomplete = collect("incomplete");
        const passes = collect("passes");
        return {
          violations,
          incomplete,
          passedRules: passes
            .map((entry) => (entry as { id?: unknown }).id)
            .filter((id): id is string => typeof id === "string"),
          nodeResults: nodeCount([violations, incomplete, passes]),
          testEngine: String((results.testEngine as { version?: unknown } | undefined)?.version ?? ""),
        };
      },
      [...AXE_RULE_SETS],
    );
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    throw new ComparisonError(
      "quality_unavailable",
      `The accessibility scan failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const findings: AccessibilityFinding[] = [];
  let skipped = 0;

  const normalize = (input: unknown, status: AccessibilityFinding["status"]): void => {
    if (!isRecord(input)) {
      skipped += 1;
      return;
    }
    const rule = readString(input, "id");
    if (rule.length === 0) {
      skipped += 1;
      return;
    }
    const description = readString(input, "description");
    const help = readString(input, "help");
    const helpUrl = readString(input, "helpUrl");
    const impact = readImpact(input.impact);
    const wcagTags = readArray(input.tags)
      .filter((tag): tag is string => typeof tag === "string" && tag.startsWith("wcag"))
      .sort();

    for (const node of readArray(input.nodes)) {
      if (!isRecord(node)) {
        skipped += 1;
        continue;
      }
      const selector = readSelector(node.target);
      if (selector.length === 0) {
        skipped += 1;
        continue;
      }
      findings.push({
        rule,
        impact,
        status,
        description,
        help,
        helpUrl,
        wcagTags,
        selector,
        html: truncate(readString(node, "html")),
        summary: truncate(readString(node, "failureSummary")),
        fingerprint: fingerprintFinding({ rule, selector }),
      });
    }
  };

  for (const entry of raw.violations) normalize(entry, "violation");
  for (const entry of raw.incomplete) normalize(entry, "needs-review");

  findings.sort((left, right) => {
    if (left.status !== right.status) return left.status === "violation" ? -1 : 1;
    if (left.rule !== right.rule) return left.rule < right.rule ? -1 : 1;
    return left.selector < right.selector ? -1 : left.selector > right.selector ? 1 : 0;
  });

  const counts = { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 };
  let needsReview = 0;
  let bestPracticeViolations = 0;

  // The complete violation set, built before any display cap. A policy must never decide
  // on a truncated list: a serious violation sorted past the cap would otherwise be
  // invisible to the verdict. One entry per fingerprint, most severe impact retained.
  const complete = new Map<string, { impact: AxeImpact | null; wcag: boolean }>();
  for (const finding of findings) {
    if (finding.status === "needs-review") {
      needsReview += 1;
      continue;
    }
    counts[finding.impact ?? "unknown"] += 1;
    const wcag = finding.wcagTags.length > 0;
    if (!wcag) bestPracticeViolations += 1;
    const existing = complete.get(finding.fingerprint);
    if (!existing) {
      complete.set(finding.fingerprint, { impact: finding.impact, wcag });
      continue;
    }
    if (impactRank(finding.impact) > impactRank(existing.impact)) existing.impact = finding.impact;
    if (wcag) existing.wcag = true;
  }

  const violations = [...complete.entries()]
    .map(([fingerprint, entry]) => ({ fingerprint, impact: entry.impact, wcag: entry.wcag }))
    .sort((left, right) => (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0));

  return {
    runner: {
      name: "axe-core",
      version: raw.testEngine.length > 0 ? raw.testEngine : AXE_VERSION,
      rulesEvaluated: raw.passedRules.length + countRules(findings),
      ruleSets: [...AXE_RULE_SETS],
      nodeResults: raw.nodeResults,
    },
    counts,
    needsReview,
    bestPracticeViolations,
    findings: findings.slice(0, maxFindings),
    violations,
    truncated: findings.length > maxFindings,
    totalFindings: findings.length,
    skippedResults: skipped,
  };
}

/** Distinct rules that appear in the findings (violations and needs-review alike). */
function countRules(findings: readonly AccessibilityFinding[]): number {
  return new Set(findings.map((finding) => finding.rule)).size;
}
