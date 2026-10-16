import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { baseUrl, ensureReport, expectVisible, launchBrowser, openConsole } from "./support/helpers";

/**
 * The regressions the Phase 1 delivery audit found, pinned so they cannot come back:
 * flex containers that scramble prose, pointer targets under 24px, a clipped slider
 * thumb, text that fails WCAG contrast, and layout that escapes a narrow viewport.
 *
 * Everything is measured from the rendered page — computed styles and geometry, the
 * same evidence the audit used.
 */

const PROBE = () => {
  const doc = document.documentElement;
  const result = {
    overflowX: doc.scrollWidth > window.innerWidth + 1,
    escaping: [] as string[],
    flexProseViolations: [] as string[],
    smallTargets: [] as Array<{ el: string; w: number; h: number; text: string }>,
    contrastFailures: [] as Array<{ el: string; ratio: number; min: number; text: string }>,
  };

  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}.${(element.className || "").toString().split(" ").slice(0, 3).join(".")}`;

  const toRgb = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const channel = (value: number) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  document.querySelectorAll("*").forEach((element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    if (style.position !== "fixed" && (rect.right > window.innerWidth + 1 || rect.left < -1)) {
      let insideScroller = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        if (["auto", "scroll", "hidden"].includes(parentStyle.overflowX)) {
          insideScroller = true;
          break;
        }
      }
      if (!insideScroller) result.escaping.push(label(element));
    }

    // Prose split into several anonymous flex items wraps out of reading order.
    if ((style.display === "flex" || style.display === "inline-flex") && !element.classList.contains("sr-only")) {
      let runs = 0;
      let inRun = false;
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          if ((node.textContent ?? "").trim().length > 0 && !inRun) {
            runs += 1;
            inRun = true;
          }
        } else {
          inRun = false;
        }
      }
      if (runs > 1) result.flexProseViolations.push(`${label(element)} — ${(element.textContent ?? "").trim().slice(0, 50)}`);
    }

    const isControl =
      element.matches('a, button, input, select, textarea, [role="button"], [role="tab"], [role="radio"]') &&
      !element.classList.contains("sr-only");
    const isInlineTextLink = element.tagName === "A" && style.display.startsWith("inline") && rect.height < 24;
    if (isControl && !isInlineTextLink && (rect.width < 24 || rect.height < 24)) {
      result.smallTargets.push({
        el: label(element),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        text: (element.textContent ?? "").trim().slice(0, 30),
      });
    }

    const hasOwnText = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
    );
    if (!hasOwnText) return;

    const foreground = toRgb(style.color);
    let background: { r: number; g: number; b: number; a: number } | null = null;
    let node: Element | null = element;
    while (node && !background) {
      const candidate = toRgb(getComputedStyle(node).backgroundColor);
      if (candidate && candidate.a > 0.95) background = candidate;
      node = node.parentElement;
    }
    if (foreground && background && foreground.a > 0.95) {
      const first = luminance(foreground);
      const second = luminance(background);
      const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      const fontSize = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const minimum = isLarge ? 3 : 4.5;
      if (ratio < minimum) {
        result.contrastFailures.push({
          el: label(element),
          ratio: Math.round(ratio * 100) / 100,
          min: minimum,
          text: (element.textContent ?? "").trim().slice(0, 40),
        });
      }
    }
  });

  return result;
};

describe("accessibility regressions", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  async function probeAt(viewport: { width: number; height: number }) {
    const page = await openConsole(browser, viewport);
    // Measure the populated dashboard, not the empty state it paints first.
    await ensureReport(page);
    const result = await page.evaluate(PROBE);
    await page.context().close();
    return result;
  }

  it("keeps prose in reading order inside flex layouts", async () => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const result = await probeAt(viewport);
      expect(result.flexProseViolations, `at ${viewport.width}px`).toEqual([]);
    }
  });

  it("keeps every control at the WCAG 2.2 minimum target size", async () => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const result = await probeAt(viewport);
      // Visually hidden radio inputs are excluded: their label is the pointer target.
      const real = result.smallTargets.filter((target) => !target.el.startsWith("input."));
      expect(real, `at ${viewport.width}px`).toEqual([]);
    }
  });

  it("keeps the tolerance slider a hairline inside a full-size hit area", async () => {
    const page = await openConsole(browser);
    await ensureReport(page);
    const slider = await page.locator('input[type="range"]').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const contentHeight = rect.height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      return {
        boxHeight: Math.round(rect.height),
        contentHeight: Math.round(contentHeight),
        backgroundClip: style.backgroundClip,
      };
    });
    await page.context().close();

    expect(slider.boxHeight).toBeGreaterThanOrEqual(24);
    expect(slider.contentHeight).toBe(6);
    expect(slider.backgroundClip).toBe("content-box");
  });

  it("keeps the artifact zoom buttons at full target size", async () => {
    const page = await openConsole(browser);
    // The console loads the last stored report on mount, so the viewer — and its zoom
    // group — appear a moment after the first paint.
    await ensureReport(page);
    await expectVisible(page.locator('[role="group"][aria-label="Zoom"]'));
    const sizes = await page.locator('[role="group"][aria-label="Zoom"] button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    );
    await page.context().close();

    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(size.height).toBeGreaterThanOrEqual(24);
      expect(size.width).toBeGreaterThanOrEqual(24);
    }
  });

  it("passes WCAG AA contrast in both colour schemes", async () => {
    for (const scheme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(baseUrl(), { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: /catch every drift/i }).waitFor();
      await ensureReport(page);
      const result = await page.evaluate(PROBE);
      await context.close();
      expect(result.contrastFailures, `${scheme} scheme`).toEqual([]);
    }
  });

  it("fits a 390px viewport without horizontal overflow", async () => {
    const result = await probeAt({ width: 390, height: 844 });
    expect(result.overflowX).toBe(false);
    expect(result.escaping).toEqual([]);
  });

  it("reaches the comparison timeline by keyboard and rings the focused bar", async () => {
    const page = await openConsole(browser);
    await ensureReport(page);

    // The timeline sits far down the page, so the generic 14-stop sweep above never gets
    // there. Walk until a bar takes focus: that also proves it is keyboard reachable.
    let reached = false;
    for (let index = 0; index < 80 && !reached; index += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.closest('[aria-label="Comparison timeline"]') !== null);
    }
    expect(reached, "the timeline was not reachable with the keyboard within 80 stops").toBe(true);

    const style = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        outline: `${computed.outlineWidth} ${computed.outlineStyle} ${computed.outlineColor}`,
        boxShadow: computed.boxShadow,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    await page.context().close();

    const drawnOutline = Number.parseFloat(style.outline) > 0 && !style.outline.includes("none");
    expect(drawnOutline || style.boxShadow !== "none", JSON.stringify(style)).toBe(true);
    expect(style.height).toBeGreaterThanOrEqual(24);
    expect(style.width).toBeGreaterThanOrEqual(24);
  });

  it("shows a focus ring on every keyboard stop", async () => {
    const page = await openConsole(browser);
    await ensureReport(page);
    const missing: string[] = [];

    for (let index = 0; index < 14; index += 1) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          outline: `${style.outlineWidth} ${style.outlineStyle}`,
          shadow: style.boxShadow,
        };
      });
      // NEXTJS-PORTAL is the dev-tools badge injected by Next.js, not part of the console.
      if (focus && focus.tag !== "NEXTJS-PORTAL") {
        if ((focus.outline.startsWith("0px") || focus.outline.includes("none")) && focus.shadow === "none") {
          missing.push(focus.tag);
        }
      }
    }
    await page.context().close();

    expect(missing).toEqual([]);
  });
});
