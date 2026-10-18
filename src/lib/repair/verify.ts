import type { DiagnosticIssue } from "@/lib/diagnosis/types";
import type {
  RegressionCheck,
  RepairMeasurement,
  RepairPageMeasurement,
  RepairVerification,
  RepairVerdict,
  SandboxCommandResult,
  ScopeCheck,
  TargetCheck,
} from "./types";

/**
 * The repair verdict, computed only from measurements.
 *
 * The policy is deliberately conservative and completely deterministic:
 *
 *  · **verified** — every target defect is gone, no previously clean route/viewport
 *    regressed, no serious or critical finding appeared, no new layout defect appeared,
 *    the patch stayed inside scope, and the configured build and test commands both ran
 *    and passed. Nothing else can produce this verdict; there is no model input at all.
 *  · **partially-improved** — the target measurably improved (or some of several targets
 *    were fixed) with no regression, but it is not gone, or one of the target checks could
 *    not be re-measured.
 *  · **rejected** — a regression, a new serious/critical finding, a new layout defect, a
 *    failing build or test, a scope violation, or a patch that changed nothing measurable.
 *  · **unverified** — the evidence needed to decide is missing: the candidate could not be
 *    measured, or no build/test command was configured. A missing check is never a pass.
 *
 * The prior "before" measurement is required. A repair is never compared with a baseline
 * the sandbox did not itself produce.
 */

/**
 * Withdraws a verdict because the developer's source tree moved under the run.
 *
 * The measurements were taken against a revision that no longer exists, so "verified" would
 * be a claim about a tree nobody has. The measurements themselves stay in the record — they
 * are evidence, and the record never rewrites one — but the verdict becomes `unverified` and
 * the reason it did is first in the list.
 */
export function invalidateForSourceDrift(
  verification: RepairVerification,
  detail: string,
): RepairVerification {
  const already = verification.regressions.some((check) => check.kind === "source");
  const check: RegressionCheck = { kind: "source", id: "source-drift", status: "unverified", detail };
  return {
    ...verification,
    verdict: "unverified",
    reasons: [detail, ...verification.reasons],
    regressions: already ? verification.regressions : [...verification.regressions, check],
  };
}

/** One sentence describing how the original tree moved, for the record and the console. */
export function sourceDriftDetail(input: {
  readonly digestBefore: string;
  readonly digestAfter: string;
  readonly commitBefore: string | null;
  readonly commitAfter: string | null;
  readonly dirtyBefore: boolean | null;
  readonly dirtyAfter: boolean | null;
}): string {
  const changes: string[] = [];
  if (input.digestBefore !== input.digestAfter) changes.push("its files changed");
  if (input.commitBefore !== input.commitAfter) {
    changes.push(`HEAD moved from ${input.commitBefore ?? "(none)"} to ${input.commitAfter ?? "(none)"}`);
  }
  if (input.dirtyBefore !== input.dirtyAfter) changes.push("its uncommitted state changed");
  const what = changes.length > 0 ? changes.join(", ") : "it no longer matches the pinned revision";
  return (
    `The source directory changed while the repair ran (${what}), so the measurements no longer describe a tree ` +
    "that exists. The verdict is withdrawn rather than reported against a revision nobody has."
  );
}

export interface VerifyRepairInput {
  /** The measured issues the proposal was allowed to address. */
  readonly targetIssues: readonly DiagnosticIssue[];
  /** Route path the stored report measured; targets are looked for there first. */
  readonly targetRoutePath: string | null;
  readonly before: RepairMeasurement;
  readonly after: RepairMeasurement | null;
  readonly scope: ScopeCheck;
  readonly build: readonly SandboxCommandResult[];
  /** The same commands on the unmodified checkout, when they were run. */
  readonly baselineBuild?: readonly SandboxCommandResult[];
  /** Overflow limit copied from the stored report's policy. */
  readonly overflowLimitPx: number;
  readonly pixelTolerance?: number;
}

function pageKey(page: RepairPageMeasurement): string {
  return `${page.routeId}@${page.viewportId}`;
}

/** The target page for an accessibility/visual issue: any page where the defect was seen. */
function targetPages(measurement: RepairMeasurement, targetRoutePath: string | null): readonly RepairPageMeasurement[] {
  const onTargetRoute = targetRoutePath
    ? measurement.pages.filter((page) => page.path === targetRoutePath)
    : [];
  return onTargetRoute.length > 0 ? onTargetRoute : measurement.pages;
}

function isPresent(page: RepairPageMeasurement, issue: DiagnosticIssue, overflowLimitPx: number): boolean {
  if (issue.kind === "accessibility") {
    const fingerprint = issue.key.slice("a11y:".length);
    return page.accessibility.fingerprints.includes(fingerprint);
  }
  if (issue.kind === "responsive") {
    return page.layout.documentOverflowPx > overflowLimitPx || page.layout.defects.length > 0;
  }
  if (issue.kind === "visual") {
    return page.visual.status === "regressed";
  }
  return false;
}

function summarizePresence(page: RepairPageMeasurement, issue: DiagnosticIssue): string {
  if (issue.kind === "accessibility") {
    return `${page.accessibility.violations} violation(s) at ${page.viewportLabel}`;
  }
  if (issue.kind === "responsive") {
    return `${page.layout.documentOverflowPx}px document overflow, ${page.layout.defects.length} element(s) escaping`;
  }
  return `${page.visual.changePercentage}% changed${page.visual.dimensionsChanged ? ", dimensions changed" : ""}`;
}

function evaluateTarget(
  issue: DiagnosticIssue,
  input: VerifyRepairInput,
): TargetCheck {
  const beforePages = targetPages(input.before, input.targetRoutePath);
  const afterPages = input.after ? targetPages(input.after, input.targetRoutePath) : [];

  const beforePage = beforePages.find((page) => isPresent(page, issue, input.overflowLimitPx)) ?? null;
  if (!beforePage) {
    return {
      issueKey: issue.key,
      title: issue.title,
      status: "not-measured",
      before: "not reproduced in the sandbox",
      after: input.after ? "not measured" : "no after measurement",
      detail:
        "The stored report measured this defect, but the unmodified sandbox did not reproduce it, so this attempt cannot be credited with fixing it.",
    };
  }

  const beforeLabel = summarizePresence(beforePage, issue);
  if (!input.after) {
    return {
      issueKey: issue.key,
      title: issue.title,
      status: "not-measured",
      before: beforeLabel,
      after: "no after measurement",
      detail: "The candidate was never measured after the patch, so nothing can be concluded.",
    };
  }

  const stillPresent = afterPages.filter((page) => isPresent(page, issue, input.overflowLimitPx));
  const afterLabel = afterPages.map((page) => summarizePresence(page, issue)).join("; ") || "no pages measured";

  if (stillPresent.length === 0) {
    // For a visual regression, "gone" means every page that was regressed now matches.
    return {
      issueKey: issue.key,
      title: issue.title,
      status: "fixed",
      before: beforeLabel,
      after: afterLabel,
      detail: "The defect is no longer present in the measured pages.",
    };
  }

  if (issue.kind === "responsive") {
    const beforeOverflow = Math.max(...beforePages.map((page) => page.layout.documentOverflowPx));
    const afterOverflow = Math.max(...afterPages.map((page) => page.layout.documentOverflowPx));
    const improved = afterOverflow < beforeOverflow;
    return {
      issueKey: issue.key,
      title: issue.title,
      status: improved ? "improved" : "unchanged",
      before: beforeLabel,
      after: afterLabel,
      detail: improved
        ? `Overflow fell from ${beforeOverflow}px to ${afterOverflow}px, but the page still exceeds the ${input.overflowLimitPx}px limit or has escaping elements.`
        : "Overflow did not improve.",
    };
  }

  if (issue.kind === "visual") {
    const beforePercentage = beforePage.visual.changePercentage;
    const afterPercentage = Math.min(...afterPages.map((page) => page.visual.changePercentage));
    const improved = afterPercentage < beforePercentage;
    return {
      issueKey: issue.key,
      title: issue.title,
      status: improved ? "improved" : "unchanged",
      before: beforeLabel,
      after: afterLabel,
      detail: improved
        ? `The visual difference fell from ${beforePercentage}% to ${afterPercentage}%, but it is still above the ${input.pixelTolerance ?? beforePage.visual.tolerance}% tolerance.`
        : "The visual difference did not improve.",
    };
  }

  const beforeViolations = Math.max(...beforePages.map((page) => page.accessibility.violations));
  const afterViolations = Math.max(...afterPages.map((page) => page.accessibility.violations));
  const improved = afterViolations < beforeViolations;
  return {
    issueKey: issue.key,
    title: issue.title,
    status: improved ? "improved" : "unchanged",
    before: beforeLabel,
    after: afterLabel,
    detail: improved
      ? `The same rule still fires, but the page now has ${afterViolations} violation(s) instead of ${beforeViolations}.`
      : "The same rule still fires on the same element.",
  };
}

function seriousAndCritical(measurement: RepairMeasurement): number {
  return measurement.pages.reduce((total, page) => total + page.accessibility.serious + page.accessibility.critical, 0);
}

function overflowTotal(measurement: RepairMeasurement): number {
  return measurement.pages.reduce((total, page) => total + page.layout.documentOverflowPx, 0);
}

/**
 * Compares every page that was measured before with the same page after. A page is keyed
 * by route and viewport, so a fix on one screen cannot hide a regression on another.
 */
function regressionChecks(input: VerifyRepairInput): { checks: RegressionCheck[]; notes: string[] } {
  const checks: RegressionCheck[] = [];
  const notes: string[] = [];
  if (!input.after) {
    return {
      checks: [{ kind: "visual", id: "after-measurement", status: "unverified", detail: "No after measurement exists." }],
      notes,
    };
  }

  const beforeByKey = new Map(input.before.pages.map((page) => [pageKey(page), page] as const));
  const afterKeys = new Set(input.after.pages.map(pageKey));

  // Every page that was measured before must have been measured again. A guard route that
  // silently disappears from the second pass would otherwise read as "no regression there".
  for (const beforePage of input.before.pages) {
    const key = pageKey(beforePage);
    if (afterKeys.has(key)) continue;
    checks.push({
      kind: "measurement",
      id: `${key}:missing-after`,
      status: "unverified",
      detail: `${key} was measured before the patch but not after it, so the candidate cannot be shown to have left it unchanged.`,
    });
  }

  for (const afterPage of input.after.pages) {
    const key = pageKey(afterPage);
    const beforePage = beforeByKey.get(key);
    if (!beforePage) {
      notes.push(`${key} was measured after the patch but not before, so it is not part of the comparison.`);
      continue;
    }

    const newFingerprints = afterPage.accessibility.fingerprints.filter(
      (fingerprint) => !beforePage.accessibility.fingerprints.includes(fingerprint),
    );
    const newSevere = newFingerprints.filter((fingerprint) => {
      const impact = afterPage.accessibility.impactByFingerprint[fingerprint] ?? "unknown";
      return impact === "serious" || impact === "critical";
    });
    if (newSevere.length > 0) {
      checks.push({
        kind: "accessibility",
        id: `${key}:new-serious`,
        status: "regression",
        detail: `${newSevere.length} new serious/critical finding(s) appeared at ${key}: ${newSevere.join(", ")}.`,
      });
    } else if (newFingerprints.length > 0) {
      checks.push({
        kind: "accessibility",
        id: `${key}:new-minor`,
        status: "clear",
        detail: `${newFingerprints.length} new minor/moderate finding(s) appeared at ${key}: ${newFingerprints.join(", ")}.`,
      });
      notes.push(
        `${key} gained ${newFingerprints.length} minor/moderate accessibility finding(s); this does not block verification but is recorded.`,
      );
    }

    if (afterPage.layout.documentOverflowPx > beforePage.layout.documentOverflowPx + 1) {
      checks.push({
        kind: "layout",
        id: `${key}:overflow`,
        status: "regression",
        detail: `Document overflow grew from ${beforePage.layout.documentOverflowPx}px to ${afterPage.layout.documentOverflowPx}px at ${key}.`,
      });
    }

    const beforeSelectors = new Set(beforePage.layout.defects.map((defect) => defect.selector));
    const newDefects = afterPage.layout.defects.filter((defect) => !beforeSelectors.has(defect.selector));
    if (newDefects.length > 0) {
      checks.push({
        kind: "layout",
        id: `${key}:new-defects`,
        status: "regression",
        detail: `${newDefects.length} element(s) newly escape the viewport at ${key}: ${newDefects.map((defect) => defect.selector).join(", ")}.`,
      });
    }

    if (afterPage.visual.dimensionsChanged) {
      checks.push({
        kind: "visual",
        id: `${key}:dimensions`,
        status: "regression",
        detail: `The page's dimensions changed at ${key}, which is never a safe repair.`,
      });
    } else if (beforePage.visual.status === "match" && afterPage.visual.status === "regressed") {
      checks.push({
        kind: "visual",
        id: `${key}:drift`,
        status: "regression",
        detail: `A page that matched its approved baseline now differs: ${afterPage.visual.detail}`,
      });
    }

    if (afterPage.visual.status === "unreadable") {
      checks.push({
        kind: "visual",
        id: `${key}:unreadable`,
        status: "unverified",
        detail: afterPage.visual.detail,
      });
    }
  }

  const beforeSerious = seriousAndCritical(input.before);
  const afterSerious = seriousAndCritical(input.after);
  if (afterSerious > beforeSerious) {
    checks.push({
      kind: "accessibility",
      id: "serious-critical-total",
      status: "regression",
      detail: `Serious and critical findings rose from ${beforeSerious} to ${afterSerious}.`,
    });
  }

  const beforeOverflow = overflowTotal(input.before);
  const afterOverflow = overflowTotal(input.after);
  if (afterOverflow > beforeOverflow) {
    notes.push(`Total document overflow grew from ${beforeOverflow}px to ${afterOverflow}px.`);
  }

  for (const command of input.build) {
    const id = command.name;
    if (command.status === "failed") {
      checks.push({
        kind: command.name === "build" ? "build" : "test",
        id,
        status: "regression",
        detail: `${command.name} failed in the sandbox${command.reason ? `: ${command.reason}` : "."}`,
      });
    } else if (command.status === "skipped") {
      checks.push({
        kind: command.name === "build" ? "build" : "test",
        id,
        status: "unverified",
        detail: command.reason ?? `${command.name} was not configured, so it could not be checked.`,
      });
    }
  }

  for (const command of input.baselineBuild ?? []) {
    if (command.status === "failed") {
      checks.push({
        kind: command.name === "build" ? "build" : "test",
        id: `${command.name}-before`,
        status: "unverified",
        detail: `The unmodified source already failed its ${command.name} command, so a patch cannot claim to keep it passing.`,
      });
    }
  }

  if (!input.scope.ok) {
    checks.push({
      kind: "scope",
      id: "scope",
      status: "regression",
      detail: `The patch touched files outside its approved scope: ${input.scope.violations.map((violation) => `${violation.path} (${violation.reason})`).join("; ")}`,
    });
  }

  return { checks, notes };
}

/** The whole policy, as one pure function. */
export function verifyRepair(input: VerifyRepairInput): RepairVerification {
  const targets = input.targetIssues.map((issue) => evaluateTarget(issue, input));
  const { checks, notes } = regressionChecks(input);
  const reasons: string[] = [];

  if (!input.after) {
    return {
      verdict: "unverified",
      reasons: ["The candidate was never measured after the patch, so no verdict can be given."],
      targets,
      regressions: checks,
      build: input.build,
      before: input.before,
      after: null,
      scope: input.scope,
      notes,
    };
  }

  // A verified verdict requires both configured commands to have run and passed. A missing
  // result is not a pass: an empty build list, or one whose entries were never recorded,
  // leaves the verdict unverified rather than taking silence for success.
  const passedNames = new Set(input.build.filter((command) => command.status === "passed").map((command) => command.name));
  const missingCommands = (["build", "test"] as const).filter((name) => !passedNames.has(name));
  if (missingCommands.length > 0) {
    checks.push({
      kind: missingCommands.includes("build") ? "build" : "test",
      id: "commands-complete",
      status: "unverified",
      detail: `No passing ${missingCommands.join(" and ")} result was recorded for this candidate, so it cannot be verified.`,
    });
  }

  const failures = checks.filter((check) => check.status === "regression");
  const unverified = checks.filter((check) => check.status === "unverified");
  const fixed = targets.filter((target) => target.status === "fixed");
  const improved = targets.filter((target) => target.status === "improved");
  const notMeasured = targets.filter((target) => target.status === "not-measured");

  if (!input.scope.ok) {
    reasons.push("The patch modified files outside the approved scope, so it was rejected before its measurements were trusted.");
  }
  for (const failure of failures) reasons.push(failure.detail);
  for (const target of targets) {
    if (target.status === "unchanged") reasons.push(`${target.issueKey} did not improve: ${target.detail}`);
  }

  let verdict: RepairVerdict;
  if (failures.length > 0) {
    verdict = "rejected";
  } else if (unverified.length > 0) {
    verdict = "unverified";
    for (const check of unverified) reasons.push(`${check.id} could not be verified: ${check.detail}`);
  } else if (fixed.length === targets.length && targets.length > 0) {
    verdict = "verified";
    reasons.push("Every target defect is gone, no measured route or viewport regressed, and the build and tests passed.");
  } else if (fixed.length > 0 || improved.length > 0) {
    verdict = "partially-improved";
    reasons.push(
      `${fixed.length + improved.length} of ${targets.length} target(s) improved but the defect is not gone, so the change is not a verified fix.`,
    );
  } else if (notMeasured.length === targets.length) {
    verdict = "unverified";
    reasons.push("None of the reported defects was reproduced in the sandbox, so this patch could not be credited with anything.");
  } else {
    verdict = "rejected";
    reasons.push("The patch did not measurably change the reported defect.");
  }

  if (verdict === "verified" && input.build.some((command) => command.status !== "passed")) {
    verdict = "unverified";
    reasons.push("A repair is only verified when the configured build and test commands both ran and passed.");
  }

  return {
    verdict,
    reasons,
    targets,
    regressions: checks,
    build: input.build,
    before: input.before,
    after: input.after,
    scope: input.scope,
    notes,
  };
}
