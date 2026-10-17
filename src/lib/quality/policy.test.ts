import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_POLICY, describePolicy, evaluateQualityPolicy, parseQualityPolicy } from "./policy";
import { fingerprintFinding } from "./fingerprint";
import type {
  AccessibilityFinding,
  AccessibilitySummary,
  QualityPolicy,
  ResponsiveFinding,
  ResponsiveSummary,
} from "./types";

/* ── builders: measurements are inputs here, never produced by this module ─────────────── */

function violation(rule: string, selector: string, impact: AccessibilityFinding["impact"]): AccessibilityFinding {
  return {
    rule,
    impact,
    status: "violation",
    description: `${rule} description`,
    help: `${rule} help`,
    helpUrl: "https://dequeuniversity.com/rules/axe/4.14/example",
    wcagTags: ["wcag2a"],
    selector,
    html: `<${rule}>`,
    summary: "",
    fingerprint: fingerprintFinding({ rule, selector }),
  };
}

function summary(findings: readonly AccessibilityFinding[]): AccessibilitySummary {
  const counts = { minor: 0, moderate: 0, serious: 0, critical: 0, unknown: 0 };
  let needsReview = 0;
  for (const finding of findings) {
    if (finding.status === "needs-review") needsReview += 1;
    else counts[finding.impact ?? "unknown"] += 1;
  }
  return {
    runner: { name: "axe-core", version: "4.14.0", rulesEvaluated: 10, ruleSets: ["wcag2a"], nodeResults: 12 },
    counts,
    needsReview,
    bestPracticeViolations: findings.filter((f) => f.status === "violation" && f.wcagTags.length === 0).length,
    findings,
    truncated: false,
    totalFindings: findings.length,
    skippedResults: 0,
  };
}

function responsiveFinding(selector: string, overflowPx: number): ResponsiveFinding {
  return {
    kind: "element-overflow",
    viewportId: "mobile",
    viewportWidth: 390,
    selector,
    overflowPx,
    rect: { x: 0, y: 0, width: 500, height: 20 },
    containedInScroller: false,
    scrollContainer: null,
    html: "<div>",
  };
}

function responsive(overrides: Partial<ResponsiveSummary> = {}): ResponsiveSummary {
  return {
    viewportId: "mobile",
    viewportWidth: 390,
    documentOverflowPx: 0,
    scrollableRegions: [],
    findings: [],
    contained: [],
    truncated: false,
    elementsMeasured: 30,
    ...overrides,
  };
}

function judge(
  policy: Partial<QualityPolicy>,
  findings: readonly AccessibilityFinding[],
  extra: {
    readonly responsive?: ResponsiveSummary[];
    readonly referenceFingerprints?: readonly string[] | null;
  } = {},
) {
  return evaluateQualityPolicy({
    policy: { ...DEFAULT_QUALITY_POLICY, ...policy },
    viewports: [
      {
        viewportId: "desktop",
        accessibility: summary(findings),
        responsive: extra.responsive?.[0] ?? responsive({ viewportId: "desktop", viewportWidth: 1280 }),
      },
      ...(extra.responsive ?? []).slice(1).map((entry) => ({
        viewportId: entry.viewportId,
        accessibility: summary([]),
        responsive: entry,
      })),
    ],
    referenceFingerprints: extra.referenceFingerprints === undefined ? null : extra.referenceFingerprints,
  });
}

/* ── policy parsing ────────────────────────────────────────────────────────────────────── */

describe("parseQualityPolicy", () => {
  it("returns the documented defaults for absent input", () => {
    expect(parseQualityPolicy(undefined)).toEqual(DEFAULT_QUALITY_POLICY);
    expect(parseQualityPolicy(null)).toEqual(DEFAULT_QUALITY_POLICY);
    expect(DEFAULT_QUALITY_POLICY.failOn).toBe("serious");
  });

  it("accepts every documented field", () => {
    const policy = parseQualityPolicy({
      failOn: "minor",
      includeBestPractice: false,
      failOnNewOnly: true,
      maxDocumentOverflowPx: 0,
      maxElementOverflowPx: 12,
    });
    expect(policy).toEqual({
      failOn: "minor",
      includeBestPractice: false,
      failOnNewOnly: true,
      maxDocumentOverflowPx: 0,
      maxElementOverflowPx: 12,
    });
  });

  it("refuses unknown fields instead of ignoring them", () => {
    expect(() => parseQualityPolicy({ failOnn: "serious" })).toThrow(/unknown quality policy field/);
    expect(() => parseQualityPolicy({ failOn: "catastrophic" })).toThrow(/failOn/);
    expect(() => parseQualityPolicy({ includeBestPractice: "yes" })).toThrow(/true or false/);
    expect(() => parseQualityPolicy({ maxElementOverflowPx: -1 })).toThrow(/pixels/);
    expect(() => parseQualityPolicy({ maxElementOverflowPx: Number.NaN })).toThrow(/pixels/);
    expect(() => parseQualityPolicy("serious")).toThrow(/JSON object/);
  });
});

describe("describePolicy", () => {
  it("names every threshold a reviewer can disagree with", () => {
    const text = describePolicy(DEFAULT_QUALITY_POLICY);
    expect(text).toContain("fail on serious");
    expect(text).toContain("1px document");
    expect(text).toContain("1px element");
  });
});

/* ── the verdict ───────────────────────────────────────────────────────────────────────── */

describe("evaluateQualityPolicy", () => {
  const seriousFinding = violation("button-name", "#save", "serious");
  const criticalFinding = violation("label", "#email", "critical");
  const minorFinding = violation("region", "footer", "minor");

  it("passes when nothing meets the threshold", () => {
    const result = judge({ failOn: "critical" }, [seriousFinding, minorFinding]);
    expect(result.verdict.status).toBe("pass");
    expect(result.verdict.failures).toEqual([]);
  });

  it("fails on findings at or above the threshold, one failure per impact band", () => {
    const result = judge({ failOn: "serious" }, [seriousFinding, criticalFinding, minorFinding]);
    expect(result.verdict.status).toBe("fail");
    const codes = result.verdict.failures.map((failure) => failure.code).sort();
    expect(codes).toEqual(["accessibility.critical", "accessibility.serious"]);
    const serious = result.verdict.failures.find((failure) => failure.code === "accessibility.serious");
    expect(serious?.count).toBe(1);
    expect(serious?.evidence).toEqual(["button-name@#save"]);
    expect(serious?.message).toContain("button-name@#save");
  });

  it("counts the same finding once even when several viewports report it", () => {
    const result = evaluateQualityPolicy({
      policy: { ...DEFAULT_QUALITY_POLICY, failOn: "minor" },
      viewports: [
        { viewportId: "desktop", accessibility: summary([seriousFinding]), responsive: responsive() },
        { viewportId: "mobile", accessibility: summary([seriousFinding]), responsive: responsive() },
      ],
      referenceFingerprints: null,
    });
    expect(result.verdict.failures).toHaveLength(1);
    expect(result.verdict.failures[0].count).toBe(1);
  });

  it("reports but never fails on findings the runner left open", () => {
    const finding = { ...seriousFinding, status: "needs-review" as const };
    const result = judge({ failOn: "minor" }, [finding]);
    expect(result.verdict.status).toBe("pass");
    expect(result.verdict.failures).toEqual([]);
  });

  it("fails on an unstated impact rather than presuming it harmless", () => {
    const finding = { ...seriousFinding, impact: null };
    const result = judge({ failOn: "critical" }, [finding]);
    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.failures[0].code).toBe("accessibility.unknown");
    expect(result.verdict.failures[0].message).toContain('impact "unknown"');
  });

  it("failOn \"none\" reports everything and fails nothing", () => {
    const result = judge({ failOn: "none" }, [criticalFinding]);
    expect(result.verdict.status).toBe("pass");
    expect(result.verdict.notes.join(" ")).toContain("never fail");
  });

  it("excludeBestPractice keeps best-practice rules out of the verdict", () => {
    const bestPractice = { ...minorFinding, wcagTags: [] };
    const counted = judge({ failOn: "minor", includeBestPractice: true }, [bestPractice]);
    expect(counted.verdict.status).toBe("fail");
    const excluded = judge({ failOn: "minor", includeBestPractice: false }, [bestPractice]);
    expect(excluded.verdict.status).toBe("pass");
  });

  it("failOnNewOnly counts only findings absent from the reference", () => {
    const known = fingerprintFinding({ rule: "label", selector: "#email" });
    const result = judge({ failOn: "critical", failOnNewOnly: true }, [criticalFinding, seriousFinding], {
      referenceFingerprints: [known],
    });
    // critical is known → counted out; serious is new but below the critical threshold.
    expect(result.verdict.status).toBe("pass");
    expect(result.newFindingFingerprints).toEqual(["button-name@#save"]);
    expect(result.knownFindingFingerprints).toEqual(["label@#email"]);
  });

  it("failOnNewOnly without a trustworthy reference counts everything and says so", () => {
    const result = judge({ failOn: "critical", failOnNewOnly: true }, [criticalFinding], {
      referenceFingerprints: null,
    });
    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.notes.join(" ")).toContain("no approved baseline");
  });

  it("distinguishes new, known and resolved against a reference", () => {
    const result = judge({ failOn: "none" }, [criticalFinding], {
      referenceFingerprints: ["label@#email", "link-name@#gone"],
    });
    expect(result.newFindingFingerprints).toEqual([]);
    expect(result.knownFindingFingerprints).toEqual(["label@#email"]);
    expect(result.resolvedFindingFingerprints).toEqual(["link-name@#gone"]);
  });
});

/* ── responsive thresholds ─────────────────────────────────────────────────────────────── */

describe("evaluateQualityPolicy · responsive", () => {
  it("fails on document-level horizontal overflow above the limit", () => {
    const result = judge({ failOn: "none" }, [], {
      responsive: [responsive({ viewportId: "mobile", viewportWidth: 390, documentOverflowPx: 240 })],
    });
    expect(result.verdict.status).toBe("fail");
    const failure = result.verdict.failures.find((entry) => entry.code === "responsive.document-overflow");
    expect(failure?.message).toContain("240px");
    expect(failure?.message).toContain("mobile");
  });

  it("fails on elements escaping the viewport above the limit, with selectors as evidence", () => {
    const result = judge({ failOn: "none", maxElementOverflowPx: 10 }, [], {
      responsive: [responsive({ findings: [responsiveFinding("main > .hero", 120)] })],
    });
    expect(result.verdict.status).toBe("fail");
    const failure = result.verdict.failures.find((entry) => entry.code === "responsive.element-overflow");
    expect(failure?.count).toBe(1);
    expect(failure?.evidence).toEqual(["main > .hero"]);
    expect(failure?.message).toContain("120px");
  });

  it("tolerates overflow at or below the configured limits", () => {
    const result = judge({ maxDocumentOverflowPx: 1, maxElementOverflowPx: 1 }, [], {
      responsive: [
        responsive({
          documentOverflowPx: 1,
          findings: [responsiveFinding("main > .hero", 1)],
          contained: [responsiveFinding("table", 300)],
        }),
      ],
    });
    expect(result.verdict.status).toBe("pass");
  });

  it("never counts overflow absorbed by a deliberate scroller", () => {
    const contained = { ...responsiveFinding("table", 300), containedInScroller: true, scrollContainer: ".grid" };
    const result = judge({ failOn: "none" }, [], {
      responsive: [responsive({ contained: [contained] })],
    });
    expect(result.verdict.status).toBe("pass");
    expect(result.verdict.failures).toEqual([]);
  });
});
