import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./support/cli";
import {
  startExampleApp,
  writeProjectConfig,
  type ExampleApp,
} from "./support/example-app";

/**
 * Phase 5, end to end: the quality gate (`uiproof audit`) on a real page, through the
 * real CLI process — the same way a developer or a CI job runs it. Nothing is stubbed:
 * Chromium captures the example application over HTTP, axe-core scans the live DOM, and
 * every exit code is read from the process.
 *
 * The seven demonstration points, in order:
 *
 *   1. A clean page passes at every viewport, with the deliberate scroller recorded as
 *      evidence, not as a defect.
 *   2. A missing accessible label is detected — and an incorrect label leaves its control
 *      unnamed, which is detected too.
 *   3. A genuine contrast failure is reported with its measured ratio (never a guess),
 *      while an undecidable one is a question for a human, not a failure.
 *   4. Horizontal overflow is detected at the mobile viewport and not at desktop.
 *   5. Restoring the original code removes those findings — and the report names exactly
 *      which findings were resolved against the approved reference.
 *   6. Existing screenshot baseline checks continue to work beside the quality gate, and
 *      a failing audit never touches an approved visual baseline.
 *   7. CI receives the documented exit status for each quality-gate policy.
 *
 * The defects are real: `applyQualityDefects()` swaps the application's own support view
 * for its deliberately broken twin (`views/quality.changed.html`), so the next capture
 * renders the five documented problems and `restoreQuality()` removes exactly them.
 */

const PROJECT_ID = "example-app";
const ROUTE_ID = "support";
const VIEWPORT = "desktop";

interface AuditFinding {
  rule: string;
  impact: string | null;
  status: "violation" | "needs-review";
  description: string;
  help: string;
  helpUrl: string;
  wcagTags: string[];
  selector: string;
  html: string;
  summary: string;
  fingerprint: string;
}

interface ResponsiveFinding {
  kind: string;
  viewportId: string;
  selector: string;
  overflowPx: number;
  containedInScroller: boolean;
  scrollContainer: string | null;
  html: string;
}

interface AuditViewportReport {
  viewport: { id: string; label: string; width: number; height: number };
  accessibility: {
    counts: Record<string, number>;
    needsReview: number;
    bestPracticeViolations: number;
    findings: AuditFinding[];
    totalFindings: number;
  };
  responsive: {
    viewportId: string;
    documentOverflowPx: number;
    scrollableRegions: string[];
    findings: ResponsiveFinding[];
    contained: ResponsiveFinding[];
    elementsMeasured: number;
  };
  screenshot: { url: string; bytes: number; width: number; height: number };
}

interface AuditReport {
  id: string;
  policy: Record<string, unknown>;
  verdict: {
    status: string;
    failures: Array<{ kind: string; code: string; message: string; count: number; evidence: string[] }>;
    notes: string[];
  };
  viewports: AuditViewportReport[];
  references: Array<{ viewportId: string; versionId: string; fingerprints: string[] }>;
  newFindingFingerprints: string[];
  knownFindingFingerprints: string[];
  resolvedFindingFingerprints: string[];
}

type AuditRun = {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
};

function reportOf(run: AuditRun): AuditReport {
  return run.json?.report as unknown as AuditReport;
}

function viewportOf(report: AuditReport, id: string): AuditViewportReport {
  const found = report.viewports.find((entry) => entry.viewport.id === id);
  if (!found) throw new Error(`No ${id} viewport in the audit report`);
  return found;
}

/** The deduplicated violation fingerprints an audit measured across all its viewports. */
function violationFingerprints(report: AuditReport): string[] {
  return [
    ...new Set(
      report.viewports.flatMap((entry) =>
        entry.accessibility.findings
          .filter((finding) => finding.status === "violation")
          .map((finding) => finding.fingerprint),
      ),
    ),
  ];
}

describe("uiproof quality gate", () => {
  let app: ExampleApp;
  let scratch = "";
  let configPath = "";
  let storeDir = "";

  const cliEnv = (): Record<string, string> => ({
    UIPROOF_PROJECTS_FILE: configPath,
    UIPROOF_DATA_DIR: storeDir,
  });

  const target = (extra: readonly string[] = []): string[] => [
    "--project",
    PROJECT_ID,
    "--route",
    ROUTE_ID,
    "--config",
    configPath,
    ...extra,
  ];

  const audit = (extra: readonly string[] = ["--json"]): Promise<AuditRun> =>
    runCli(["audit", ...target(), ...extra], { env: cliEnv() });

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [5321, 5322, 5323, 5324] });
    scratch = path.join(os.tmpdir(), `uiproof-quality-${randomUUID()}`);
    storeDir = path.join(scratch, "data");
    await mkdir(storeDir, { recursive: true });

    configPath = path.join(scratch, "uiproof.config.json");
    await writeProjectConfig(configPath, [
      {
        id: PROJECT_ID,
        name: "Example app",
        origin: app.url,
        routes: [{ id: ROUTE_ID, name: "Contact support", path: "/support" }],
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("1. a clean page passes at every viewport, and the deliberate scroller is evidence, not a defect", async () => {
    const run = await audit();
    expect(run.code).toBe(0);
    expect(run.json?.status).toBe("pass");
    expect(run.json?.exitCode).toBe(0);

    const report = reportOf(run);
    // Every viewport preset is measured — desktop, tablet and mobile.
    expect(report.viewports.map((entry) => entry.viewport.id).sort()).toEqual(["desktop", "mobile", "tablet"]);
    expect(report.verdict.status).toBe("pass");
    expect(report.verdict.failures).toEqual([]);

    for (const entry of report.viewports) {
      expect(entry.accessibility.totalFindings).toBe(0);
      expect(entry.accessibility.findings).toEqual([]);
      expect(entry.accessibility.needsReview).toBe(0);
      expect(entry.responsive.findings).toEqual([]);
      expect(entry.responsive.documentOverflowPx).toBe(0);
    }

    // The table that is wider than a phone is a deliberate scroller: it is recorded as
    // contained evidence with the region that absorbs it, and never as a defect.
    const mobile = viewportOf(report, "mobile");
    expect(mobile.responsive.contained.length).toBeGreaterThan(0);
    for (const contained of mobile.responsive.contained) {
      expect(contained.containedInScroller).toBe(true);
      expect(contained.scrollContainer).toContain("table-scroll");
    }
    expect(mobile.responsive.scrollableRegions.join(" ")).toContain("table-scroll");

    // Structured evidence on disk: the JSON the CLI printed is the report that was
    // persisted, and one screenshot per viewport sits beside it.
    const reportPath = run.json?.reportPath as string;
    expect(reportPath).toBe(`audits/${report.id}/audit.json`);
    const persisted = JSON.parse(await readFile(path.join(storeDir, reportPath), "utf8")) as AuditReport;
    expect(persisted).toEqual(report);
    for (const entry of report.viewports) {
      expect(entry.screenshot.url).toContain(`${entry.viewport.id}.png`);
      const png = await readFile(path.join(storeDir, "audits", report.id, `${entry.viewport.id}.png`));
      expect(png.byteLength).toBeGreaterThan(1000);
    }

    // The human-readable trail is on stderr in JSON mode, and the evidence line names a
    // path a person can open rather than one relative to the store they cannot see.
    expect(run.stderr).toContain("QUALITY PASS");
    expect(run.stderr).toContain("not a defect");
    expect(run.stderr).toContain(path.join(storeDir, "audits", report.id));
  }, 120_000);

  it("2. a missing accessible label is detected, and an incorrect one leaves its control unnamed", async () => {
    // A trustworthy reference: approve the clean page's accessibility snapshot first, so
    // the run below can say which findings are *newly introduced*.
    const approval = await runCli(["capture", ...target(), "--quality", "--approve", "--json"], { env: cliEnv() });
    expect(approval.code).toBe(0);
    expect(approval.json?.status).toBe("captured");

    await app.applyQualityDefects();
    const run = await audit(["--new-only", "--json"]);
    expect(run.code).toBe(1);
    expect(run.json?.status).toBe("fail");
    expect(run.stderr).toContain("QUALITY FAIL");

    const report = reportOf(run);
    const findings = viewportOf(report, VIEWPORT).accessibility.findings;

    // Defect 1: the email field has nothing that names it.
    const label = findings.find((finding) => finding.rule === "label");
    expect(label).toBeDefined();
    expect(label!.status).toBe("violation");
    expect(label!.impact).toBe("critical");
    expect(label!.selector).toContain("#support-email");
    expect(label!.html).toContain("<input");
    expect(label!.fingerprint).toBe(`label@${label!.selector}`);
    expect(label!.help).toContain("label");
    expect(label!.helpUrl).toMatch(/^https:\/\//);
    expect(label!.description.length).toBeGreaterThan(0);

    // Defect 2: the topic label's for= points at an id that is not there, so the select
    // is left with no accessible name at all.
    const selectName = findings.find((finding) => finding.rule === "select-name");
    expect(selectName).toBeDefined();
    expect(selectName!.selector).toContain("#support-topic");
    expect(selectName!.status).toBe("violation");
    expect(selectName!.impact).toBe("critical");

    // Defect 3: the icon-only button's content is aria-hidden, so it has no name either.
    const buttonName = findings.find((finding) => finding.rule === "button-name");
    expect(buttonName).toBeDefined();
    expect(buttonName!.status).toBe("violation");
    expect(buttonName!.impact).toBe("critical");
    expect(buttonName!.html).toContain("aria-hidden");

    // Every finding carries structured evidence, not a score.
    for (const finding of findings) {
      expect(finding.rule.length).toBeGreaterThan(0);
      expect(finding.selector.length).toBeGreaterThan(0);
      expect(finding.html.length).toBeGreaterThan(0);
      expect(finding.helpUrl).toMatch(/^https:\/\//);
    }

    // Against the approved clean reference every one of these is a *new* finding — the
    // verdict counts exactly the violations, fingerprints and all.
    expect(new Set(report.newFindingFingerprints)).toEqual(new Set(violationFingerprints(report)));
    expect(report.knownFindingFingerprints).toEqual([]);
    expect(report.references).toHaveLength(1);
    expect(report.references[0].viewportId).toBe(VIEWPORT);
  }, 120_000);

  it("3. a genuine contrast failure is reported with its measured ratio, and an undecidable one is a question", async () => {
    const run = await audit(["--viewport", VIEWPORT, "--json"]);
    expect(run.code).toBe(1);

    const report = reportOf(run);
    const summary = viewportOf(report, VIEWPORT).accessibility;

    // Defect 4: the muted note. The evidence carries the measured ratio and the colours
    // it was measured with — a number computed from the rendered page, not a guess.
    const contrast = summary.findings.find(
      (finding) => finding.rule === "color-contrast" && finding.status === "violation",
    );
    expect(contrast).toBeDefined();
    expect(contrast!.impact).toBe("serious");
    expect(contrast!.summary).toMatch(/insufficient color contrast of \d/);
    expect(contrast!.summary).toContain("#9a9a9a");
    expect(contrast!.summary).toContain("#ffffff");
    expect(contrast!.summary).toContain("4.5:1");
    expect(contrast!.wcagTags).toContain("wcag2aa");
    expect(contrast!.html).toContain("#9a9a9a");

    // The ✎ glyph's contrast cannot be computed (non-text content): axe declines to
    // decide, so it is a needs-review question. It is reported — never counted as a
    // violation and never able to fail the check on its own.
    const review = summary.findings.find((finding) => finding.status === "needs-review");
    expect(review).toBeDefined();
    expect(review!.rule).toBe("color-contrast");
    expect(review!.summary).toContain("non-text characters");

    expect(summary.counts.serious).toBe(1);
    expect(summary.needsReview).toBe(1);
    expect(summary.totalFindings).toBe(summary.counts.critical + summary.counts.serious + summary.counts.moderate + summary.counts.minor + summary.needsReview);

    // The policy failure names the real violation's fingerprint and not the question's.
    const failure = report.verdict.failures.find((entry) => entry.code === "accessibility.serious");
    expect(failure).toBeDefined();
    expect(failure!.evidence).toEqual([contrast!.fingerprint]);
    expect(failure!.evidence).not.toContain(review!.fingerprint);
    expect(failure!.message).toContain("serious");
  }, 120_000);

  it("4. horizontal overflow is detected at the mobile viewport and not at desktop", async () => {
    // Defect 5: the maintenance banner is a fixed 720px wide.
    const mobileRun = await audit(["--viewport", "mobile", "--json"]);
    expect(mobileRun.code).toBe(1);

    const mobile = viewportOf(reportOf(mobileRun), "mobile");
    expect(mobile.responsive.documentOverflowPx).toBeGreaterThan(300);

    const banner = mobile.responsive.findings.find((finding) => finding.selector.includes("maintenance-banner"));
    expect(banner).toBeDefined();
    expect(banner!.kind).toBe("element-overflow");
    expect(banner!.overflowPx).toBeGreaterThan(300);
    expect(banner!.containedInScroller).toBe(false);
    expect(banner!.scrollContainer).toBeNull();
    expect(banner!.html).toContain("maintenance-banner");

    const codes = reportOf(mobileRun).verdict.failures.map((failure) => failure.code);
    expect(codes).toContain("responsive.document-overflow");
    expect(codes).toContain("responsive.element-overflow");
    const layoutFailure = reportOf(mobileRun).verdict.failures.find(
      (failure) => failure.code === "responsive.element-overflow",
    );
    expect(layoutFailure!.message).toContain("mobile");
    expect(layoutFailure!.evidence.join(" ")).toContain("maintenance-banner");

    // The deliberate table scroller is still evidence even while the banner escapes.
    expect(mobile.responsive.contained.length).toBeGreaterThan(0);
    expect(mobile.responsive.findings.map((finding) => finding.selector).join(" ")).not.toContain("table-scroll");

    // The same page at desktop: the banner fits, so nothing escapes the viewport and no
    // responsive failure is raised. (The accessibility defects still fail this run.)
    const desktopRun = await audit(["--viewport", VIEWPORT, "--json"]);
    expect(desktopRun.code).toBe(1);
    const desktop = viewportOf(reportOf(desktopRun), VIEWPORT);
    expect(desktop.responsive.findings).toEqual([]);
    expect(desktop.responsive.documentOverflowPx).toBe(0);
    for (const failure of reportOf(desktopRun).verdict.failures) {
      expect(failure.code.startsWith("responsive.")).toBe(false);
    }
  }, 120_000);

  it("5. restoring the original code removes those findings, and the report names what was resolved", async () => {
    // Approve the defective page: this reference records the five fingerprints, so the
    // next run can say which findings the restore fixed.
    const approval = await runCli(["capture", ...target(), "--quality", "--approve", "--json"], { env: cliEnv() });
    expect(approval.code).toBe(0);

    // Scoped to desktop: the banner's mobile overflow is a layout failure the policy
    // raises on its own, and this demonstration is about accessibility fingerprints.
    const knownRun = await audit(["--new-only", "--viewport", VIEWPORT, "--json"]);
    expect(knownRun.code).toBe(0);
    const before = reportOf(knownRun);
    const defects = violationFingerprints(before);
    expect(defects.length).toBeGreaterThan(0);
    expect(new Set(before.knownFindingFingerprints)).toEqual(new Set(defects));
    expect(before.newFindingFingerprints).toEqual([]);

    await app.restoreQuality();

    // Same policy, same reference, the original code back: every finding is gone and the
    // report names each one as resolved.
    const resolvedRun = await audit(["--new-only", "--viewport", VIEWPORT, "--json"]);
    expect(resolvedRun.code).toBe(0);
    const after = reportOf(resolvedRun);
    expect(new Set(after.resolvedFindingFingerprints)).toEqual(new Set(defects));
    expect(after.newFindingFingerprints).toEqual([]);
    expect(after.knownFindingFingerprints).toEqual([]);

    // And a plain audit is clean at every viewport again — point 1 holds after the round
    // trip, with no findings left anywhere.
    const clean = await audit();
    expect(clean.code).toBe(0);
    expect(clean.json?.status).toBe("pass");
    for (const entry of reportOf(clean).viewports) {
      expect(entry.accessibility.totalFindings).toBe(0);
      expect(entry.responsive.findings).toEqual([]);
    }
  }, 120_000);

  it("6. screenshot baseline checks keep working, and a failing audit never touches the baseline", async () => {
    // The visual workflow, exactly as before this phase — starting from the restored page.
    await app.restoreQuality();
    const capture = await runCli(["capture", ...target(), "--approve", "--json"], { env: cliEnv() });
    expect(capture.code).toBe(0);
    expect(capture.json?.status).toBe("captured");
    const approvedId = (capture.json?.approved as { id: string }).id;

    const pass = await runCli(["check", ...target(), "--json"], { env: cliEnv() });
    expect(pass.code).toBe(0);
    expect(pass.json?.status).toBe("pass");

    const statusBefore = await runCli(["baselines", "status", "--json"], { env: cliEnv() });
    const entryBefore = (statusBefore.json?.baselines as Array<{ activeVersionId: string; versions: unknown[] }>)[0];

    // A real UI change is caught by the visual gate as a measured regression…
    await app.applyQualityDefects();
    const regression = await runCli(["check", ...target(), "--json"], { env: cliEnv() });
    expect(regression.code).toBe(1);
    expect(regression.json?.status).toBe("regression");
    expect(regression.stderr).toContain("REGRESSION");

    // …and the quality gate fails on the same change. Neither failure approves, replaces
    // or otherwise modifies the approved baseline.
    const failed = await audit(["--viewport", VIEWPORT, "--json"]);
    expect(failed.code).toBe(1);

    const statusAfter = await runCli(["baselines", "status", "--json"], { env: cliEnv() });
    const entryAfter = (statusAfter.json?.baselines as Array<{ activeVersionId: string; versions: unknown[] }>)[0];
    expect(entryAfter.activeVersionId).toBe(entryBefore.activeVersionId);
    expect(entryAfter.activeVersionId).toBe(approvedId);
    expect(entryAfter.versions).toHaveLength(entryBefore.versions.length);

    // Restoring the code restores the pass.
    await app.restoreQuality();
    const recovered = await runCli(["check", ...target()], { env: cliEnv() });
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toMatch(/PASS/);
  }, 120_000);

  it("7. CI receives the documented exit status for each quality-gate policy", async () => {
    await app.applyQualityDefects();

    // --fail-on none: findings are reported in full but nothing fails the check.
    const reported = await audit(["--viewport", VIEWPORT, "--fail-on", "none", "--json"]);
    expect(reported.code).toBe(0);
    expect(reported.json?.status).toBe("pass");
    expect(reportOf(reported).viewports[0].accessibility.totalFindings).toBeGreaterThan(0);
    expect(reportOf(reported).verdict.notes.join(" ")).toContain("never fail");
    expect(reported.json?.exitCode).toBe(reported.code);

    // --fail-on critical: three critical name failures exist, so the gate fails.
    const critical = await audit(["--viewport", VIEWPORT, "--fail-on", "critical", "--json"]);
    expect(critical.code).toBe(1);
    expect(reportOf(critical).verdict.failures.map((f) => f.code)).toEqual(["accessibility.critical"]);

    // The default threshold (serious) and the strictest (minor) also fail.
    const serious = await audit(["--viewport", VIEWPORT, "--json"]);
    expect(serious.code).toBe(1);
    const minor = await audit(["--viewport", VIEWPORT, "--fail-on", "minor", "--json"]);
    expect(minor.code).toBe(1);

    // --wcag-only excludes best-practice rules from the policy: these defects are all
    // WCAG-tagged, so the gate still fails — with the narrower policy on the record.
    const wcag = await audit(["--viewport", VIEWPORT, "--wcag-only", "--json"]);
    expect(wcag.code).toBe(1);
    expect((wcag.json?.policy as Record<string, unknown>).includeBestPractice).toBe(false);

    // The responsive gate is independent of --fail-on: a page that escapes the viewport
    // fails at mobile even when accessibility findings are only reported.
    const layout = await audit(["--viewport", "mobile", "--fail-on", "none", "--json"]);
    expect(layout.code).toBe(1);
    expect(reportOf(layout).verdict.failures.map((f) => f.code)).toContain("responsive.document-overflow");

    // Both overflow thresholds are numbers a reviewer can disagree with — raise them and
    // the same page passes.
    const lenient = await audit([
      "--viewport",
      "mobile",
      "--fail-on",
      "none",
      "--max-document-overflow",
      "500",
      "--max-element-overflow",
      "500",
      "--json",
    ]);
    expect(lenient.code).toBe(0);
    expect(lenient.json?.status).toBe("pass");

    // A policy that cannot be parsed is a usage error: exit 2, nothing measured.
    const badPolicy = await audit(["--fail-on", "nonsense"]);
    expect(badPolicy.code).toBe(2);
    expect(badPolicy.stderr).toContain("--fail-on must be one of");
    expect(badPolicy.stdout).toBe("");
  }, 120_000);
});
