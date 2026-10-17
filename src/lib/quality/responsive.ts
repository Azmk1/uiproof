import type { Page } from "playwright";
import { ComparisonError } from "@/lib/compare/errors";
import type { ViewportPreset } from "@/lib/compare/types";
import type { ElementRect, ResponsiveFinding, ResponsiveSummary } from "./types";

/**
 * The responsive audit: measurable layout facts, nothing about taste.
 *
 * One question is asked per viewport: **does content escape the viewport it is being shown
 * in?** Everything here is a number a browser produced — a document that scrolls sideways,
 * an element whose right edge sits past the viewport edge — and nothing is scored.
 *
 * Three decisions make the difference between a useful check and a noisy one:
 *
 *  · **A deliberate scroller is not a defect.** A horizontally scrollable table is a design
 *    decision. Overflow that a real horizontal scroll container (something that actually
 *    scrolls) absorbs is recorded as evidence under `contained`, and never as a finding.
 *  · **Report the cause, not the hundred symptoms.** When a fixed-width container is wider
 *    than the viewport, every one of its children overflows too. An offender whose own
 *    ancestor already overflows in the same direction by at least as much is dropped, so
 *    the container is reported once instead of each descendant.
 *  · **Sub-pixel rounding is not overflow.** Layout produces fractional edges; the
 *    tolerance keeps 0.4px of rounding from reading as a bug. It is a threshold that can be
 *    read and disagreed with, which is the point.
 *
 * What is deliberately *not* checked: text clipping inside an `overflow: hidden` ancestor
 * (usually intentional — visually hidden labels, decorative crops), stacking and overlap,
 * tap-target size, and anything else that would require the harness to form an opinion
 * about the design rather than measure it.
 */

/** Overflow at or below this many pixels is rounding, not a defect. */
export const OVERFLOW_TOLERANCE_PX = 1;

const MAX_FINDINGS = 40;
const MAX_CONTAINED = 20;
const MAX_SCROLLABLE_REGIONS = 20;
const MAX_HTML_LENGTH = 300;

interface ResponsiveScriptPayload {
  readonly viewportId: string;
  readonly tolerance: number;
  readonly maxHtmlLength: number;
  readonly maxContained: number;
  readonly maxRegions: number;
}

interface ResponsiveScriptResult {
  readonly viewportWidth: number;
  readonly documentOverflowPx: number;
  readonly scrollableRegions: readonly string[];
  readonly findings: readonly ResponsiveFinding[];
  readonly contained: readonly ResponsiveFinding[];
  readonly elementsMeasured: number;
}

/**
 * Measures one already-captured page. The page instance is the one the screenshot came
 * from, so a layout finding and a pixel describe the same rendering.
 */
export async function measureResponsive(page: Page, viewport: ViewportPreset): Promise<ResponsiveSummary> {
  const payload: ResponsiveScriptPayload = {
    viewportId: viewport.id,
    tolerance: OVERFLOW_TOLERANCE_PX,
    maxHtmlLength: MAX_HTML_LENGTH,
    maxContained: MAX_CONTAINED,
    maxRegions: MAX_SCROLLABLE_REGIONS,
  };

  let raw: ResponsiveScriptResult;
  try {
    raw = await page.evaluate((input: ResponsiveScriptPayload): ResponsiveScriptResult => {
      const { viewportId, tolerance, maxHtmlLength, maxContained, maxRegions } = input;
      const root = document.documentElement;
      const viewportWidth = root.clientWidth;
      const round = (value: number) => Math.round(value * 100) / 100;

      const cssEscape = (value: string): string =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(value)
          : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

      /** A short, stable, human-readable path: `main#content > ul.list > li:nth-of-type(3)`. */
      const describe = (element: Element): string => {
        const parts: string[] = [];
        let node: Element | null = element;
        while (node !== null && parts.length < 4) {
          let part = node.tagName.toLowerCase();
          const id = node.getAttribute("id");
          if (id !== null && id.length > 0) {
            parts.unshift(`${part}#${cssEscape(id)}`);
            break;
          }
          const classes = (node.getAttribute("class") ?? "")
            .split(/\s+/)
            .filter((name) => name.length > 0)
            .slice(0, 2);
          if (classes.length > 0) part += `.${classes.map(cssEscape).join(".")}`;
          const parent: Element | null = node.parentElement;
          if (parent !== null) {
            const tag = node.tagName;
            const siblings = Array.from(parent.children).filter((child) => child.tagName === tag);
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(" > ");
      };

      const snippet = (element: Element): string => {
        const markup = element.outerHTML.replace(/\s+/g, " ").trim();
        return markup.length <= maxHtmlLength ? markup : `${markup.slice(0, maxHtmlLength - 1)}…`;
      };

      const scrollsHorizontally = (element: Element): boolean => {
        const style = getComputedStyle(element);
        if (style.overflowX !== "auto" && style.overflowX !== "scroll") return false;
        return element.scrollWidth - element.clientWidth > tolerance;
      };

      const scrollContainerOf = (element: Element): Element | null => {
        let node: Element | null = element.parentElement;
        while (node !== null) {
          if (scrollsHorizontally(node)) return node;
          node = node.parentElement;
        }
        return null;
      };

      const rectOf = (element: Element): ElementRect => {
        const rect = element.getBoundingClientRect();
        return {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        };
      };

      const all = Array.from(root.querySelectorAll("*"));

      const scrollableRegions: string[] = [];
      for (const element of all) {
        if (scrollableRegions.length >= maxRegions) break;
        if (scrollsHorizontally(element)) scrollableRegions.push(describe(element));
      }

      interface Candidate {
        readonly element: Element;
        readonly right: number;
        readonly left: number;
        readonly overflow: number;
        readonly containedBy: Element | null;
      }

      const candidates: Candidate[] = [];
      for (const element of all) {
        if (element === root || element === document.body) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const right = rect.right - viewportWidth;
        const left = -rect.left;
        const overflow = Math.max(right, left);
        if (overflow <= tolerance) continue;
        candidates.push({ element, right, left, overflow, containedBy: scrollContainerOf(element) });
      }

      /**
       * True when an ancestor's own box already overflows in the same direction by at least
       * as much — the ancestor is the cause, so this reading would be a duplicate symptom.
       * Ancestor rects are used, not their `scrollWidth`: an ancestor's scroll width grows
       * because of its children and would collapse the whole page into one finding.
       */
      const isRedundant = (candidate: Candidate): boolean => {
        let node: Element | null = candidate.element.parentElement;
        while (node !== null) {
          if (node !== root) {
            const rect = node.getBoundingClientRect();
            const right = rect.right - viewportWidth;
            const left = -rect.left;
            if (candidate.right > tolerance && right >= candidate.right - tolerance) return true;
            if (candidate.left > tolerance && left >= candidate.left - tolerance) return true;
          }
          node = node.parentElement;
        }
        return false;
      };

      const bySeverity = (left: ResponsiveFinding, right: ResponsiveFinding) => {
        if (left.overflowPx !== right.overflowPx) return right.overflowPx - left.overflowPx;
        return left.selector < right.selector ? -1 : 1;
      };

      const defects: ResponsiveFinding[] = [];
      const absorbed: ResponsiveFinding[] = [];

      for (const candidate of candidates) {
        const isContained = candidate.containedBy !== null;
        if (isContained && absorbed.length >= maxContained) continue;
        if (!isContained && isRedundant(candidate)) continue;
        const entry: ResponsiveFinding = {
          kind: "element-overflow",
          viewportId,
          viewportWidth,
          selector: describe(candidate.element),
          overflowPx: round(Math.max(candidate.right, candidate.left)),
          rect: rectOf(candidate.element),
          containedInScroller: isContained,
          scrollContainer: candidate.containedBy === null ? null : describe(candidate.containedBy),
          html: snippet(candidate.element),
        };
        (isContained ? absorbed : defects).push(entry);
      }

      defects.sort(bySeverity);
      absorbed.sort(bySeverity);

      const documentOverflowPx = Math.max(0, root.scrollWidth - viewportWidth);

      return {
        viewportWidth,
        documentOverflowPx: round(documentOverflowPx),
        scrollableRegions,
        findings: defects,
        contained: absorbed,
        elementsMeasured: all.length,
      };
    }, payload);
  } catch (cause) {
    if (cause instanceof ComparisonError) throw cause;
    throw new ComparisonError(
      "quality_unavailable",
      `The responsive audit could not measure the page: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  return {
    viewportId: viewport.id,
    viewportWidth: raw.viewportWidth,
    documentOverflowPx: raw.documentOverflowPx,
    scrollableRegions: raw.scrollableRegions,
    findings: raw.findings.slice(0, MAX_FINDINGS),
    // The complete defect set, before the display cap: a policy must never pass a layout
    // because the element that escaped was number 41 of 40 reported defects.
    defects: raw.findings.map((finding) => ({ selector: finding.selector, overflowPx: finding.overflowPx })),
    contained: raw.contained.slice(0, MAX_CONTAINED),
    truncated: raw.findings.length > MAX_FINDINGS,
    elementsMeasured: raw.elementsMeasured,
  };
}
