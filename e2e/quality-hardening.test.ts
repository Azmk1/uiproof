import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./support/cli";
import { startExampleApp, writeProjectConfig, type ExampleApp } from "./support/example-app";

/**
 * Phase 5.1, end to end, through the real CLI process and real Chromium: the quality gate's
 * three failure modes that must never produce a false pass.
 *
 *   1. **A truncated report.** `views/quality.flood.html` produces 68 findings — more than
 *      the 60-finding display cap — and its only serious violation sorts past the cap. A
 *      policy that read the truncated list would see sixty moderate best-practice findings,
 *      decide nothing met `--fail-on serious`, and pass a page with a serious violation on
 *      it. The assertion below pins both halves: the readable list really is capped and
 *      really does not contain the serious finding, and the verdict fails on it anyway.
 *
 *   2. **A missing viewport reference.** An approval made at desktop is an approval of the
 *      desktop rendering. The same finding on mobile is *not* authorised by it — axe can
 *      legitimately report a different result at a different size — so a `--new-only` audit
 *      that covers mobile fails, while the desktop-only audit of the same page passes.
 *
 *   3. **A portable reference.** Those approvals travel: exported into a bundle, imported
 *      into a second, empty store, and the classification (`--new-only`) is exactly what the
 *      local store produced. Without this, a clean CI runner would find no reference and
 *      silently count every pre-existing finding as new.
 *
 *   4. **A scan that cannot run.** `views/quality.csp.html` is the clean support page served
 *      with `Content-Security-Policy: script-src 'self'`, which blocks axe-core's inline
 *      injection. The audit must answer the documented infrastructure failure (exit 2) and
 *      persist nothing — a clean verdict that was never measured is the one outcome that
 *      would be worse than a failure.
 */

const PROJECT_ID = "example-app";
const SUPPORT = "support";
const FLOOD = "support-flood";
const CSP = "support-csp";

interface AuditFinding {
  rule: string;
  impact: string | null;
  status: "violation" | "needs-review";
  selector: string;
  fingerprint: string;
}

interface AccessibilitySummary {
  counts: Record<string, number>;
  findings: AuditFinding[];
  violations: Array<{ fingerprint: string; impact: string | null; wcag: boolean }>;
  truncated: boolean;
  totalFindings: number;
}

interface AuditViewport {
  viewport: { id: string; label: string };
  accessibility: AccessibilitySummary;
  responsive: { viewportId: string; documentOverflowPx: number; findings: unknown[]; defects: unknown[] };
  screenshot: { url: string; bytes: number };
}

interface AuditReport {
  id: string;
  verdict: { status: string; failures: Array<{ kind: string; code: string; count: number; evidence: string[]; message: string }>; notes: string[] };
  viewports: AuditViewport[];
  references: Array<{ viewportId: string; versionId: string; fingerprints: string[] }>;
  newFindingFingerprints: string[];
  knownFindingFingerprints: string[];
  resolvedFindingFingerprints: string[];
}

type Run = Awaited<ReturnType<typeof runCli>>;

function reportOf(run: Run): AuditReport {
  return run.json?.report as unknown as AuditReport;
}

function viewportOf(report: AuditReport, id: string): AuditViewport {
  const found = report.viewports.find((entry) => entry.viewport.id === id);
  if (!found) throw new Error(`No ${id} viewport in the report`);
  return found;
}

describe("the quality gate's hardened failure modes", () => {
  let app: ExampleApp;
  let scratch = "";
  let configPath = "";
  let storeDir = "";
  let portableStoreDir = "";
  let bundleDir = "";

  const cliEnv = (store: string): Record<string, string> => ({
    UIPROOF_PROJECTS_FILE: configPath,
    UIPROOF_DATA_DIR: store,
  });

  const route = (id: string, extra: readonly string[] = []): string[] => [
    "--project",
    PROJECT_ID,
    "--route",
    id,
    "--config",
    configPath,
    ...extra,
  ];

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [5331, 5332, 5333, 5334] });
    scratch = path.join(os.tmpdir(), `uiproof-quality-hardening-${randomUUID()}`);
    storeDir = path.join(scratch, "data");
    portableStoreDir = path.join(scratch, "portable-data");
    bundleDir = path.join(scratch, "bundle");
    await mkdir(storeDir, { recursive: true });
    await mkdir(portableStoreDir, { recursive: true });

    configPath = path.join(scratch, "uiproof.config.json");
    await writeProjectConfig(configPath, [
      {
        id: PROJECT_ID,
        name: "Example app",
        origin: app.url,
        routes: [
          { id: SUPPORT, name: "Contact support", path: "/support" },
          { id: FLOOD, name: "Support export, stress fixture", path: "/support-flood" },
          { id: CSP, name: "Support page that refuses the scanner", path: "/support-csp" },
        ],
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.restoreQuality().catch(() => undefined);
    await app?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("fails on a serious violation that sorted past the report's display cap", async () => {
    const run = await runCli(["audit", ...route(FLOOD, ["--viewport", "desktop", "--fail-on", "serious", "--json"])], {
      env: cliEnv(storeDir),
    });
    expect(run.code).toBe(1);

    const report = reportOf(run);
    const desktop = viewportOf(report, "desktop");

    // The measurement is complete even though the report is not.
    expect(desktop.accessibility.totalFindings).toBeGreaterThan(60);
    expect(desktop.accessibility.truncated).toBe(true);
    expect(desktop.accessibility.findings).toHaveLength(60);
    expect(desktop.accessibility.violations.length).toBe(desktop.accessibility.totalFindings);

    // What makes this fixture decisive: the truncated list a policy could have read contains
    // nothing severe enough to fail. The complete index does.
    const displayedSerious = desktop.accessibility.findings.filter(
      (finding) => finding.impact === "serious" || finding.impact === "critical",
    );
    expect(displayedSerious).toEqual([]);
    const beyondCap = desktop.accessibility.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(beyondCap.length).toBeGreaterThan(0);

    // The verdict names it, with the fingerprint as evidence, and says the report was capped.
    expect(report.verdict.status).toBe("fail");
    const serious = report.verdict.failures.find((failure) => failure.code === "accessibility.serious");
    expect(serious).toBeDefined();
    expect(serious!.evidence.some((fingerprint) => fingerprint.startsWith("svg-img-alt@"))).toBe(true);
    expect(serious!.count).toBe(serious!.evidence.length);
    expect(report.verdict.notes.join(" ")).toContain("the verdict evaluated all");

    // And the human trail says the same thing rather than showing a silently short list.
    expect(run.stderr).toContain("the verdict evaluated all");
    expect(run.stderr).toContain("QUALITY FAIL");
  }, 120_000);

  it("does not let a desktop approval authorise the same finding on mobile", async () => {
    // The page is approved exactly as it is — with its defects — at desktop only. That is an
    // explicit decision, and it is what makes the mobile audit meaningful: the same
    // fingerprints exist at both viewports, so a matcher that merged approvals across
    // viewports would classify everything as known and pass.
    await app.applyQualityDefects();
    const approval = await runCli(
      ["capture", ...route(SUPPORT, ["--viewport", "desktop", "--quality", "--approve", "--json"])],
      { env: cliEnv(storeDir) },
    );
    expect(approval.code).toBe(0);
    const approvedFingerprints = (approval.json?.report as unknown as { quality: { accessibility: { violations: unknown[] } } })
      .quality.accessibility.violations.length;
    expect(approvedFingerprints).toBeGreaterThan(0);

    const all = await runCli(
      ["audit", ...route(SUPPORT, ["--fail-on", "serious", "--new-only", "--json"])],
      { env: cliEnv(storeDir) },
    );
    expect(all.code).toBe(1);
    const allReport = reportOf(all);
    expect(allReport.references).toHaveLength(1);
    expect(allReport.references[0].viewportId).toBe("desktop");
    expect(allReport.newFindingFingerprints.length).toBeGreaterThan(0);
    expect(allReport.verdict.notes.join(" ")).toContain("No approved accessibility snapshot exists for mobile");
    expect(allReport.verdict.notes.join(" ")).toContain("No approved accessibility snapshot exists for tablet");

    // The same page, audited only where it was approved, passes: the desktop reference works.
    const desktop = await runCli(
      ["audit", ...route(SUPPORT, ["--viewport", "desktop", "--fail-on", "serious", "--new-only", "--json"])],
      { env: cliEnv(storeDir) },
    );
    expect(desktop.code).toBe(0);
    const desktopReport = reportOf(desktop);
    expect(desktopReport.newFindingFingerprints).toEqual([]);
    expect(desktopReport.knownFindingFingerprints.length).toBeGreaterThan(0);

    await app.restoreQuality();
  }, 240_000);

  it("carries the approved snapshots through export and import without changing the classification", async () => {
    await app.applyQualityDefects();
    const approval = await runCli(
      ["capture", ...route(SUPPORT, ["--viewport", "desktop", "--quality", "--approve", "--json"])],
      { env: cliEnv(storeDir) },
    );
    expect(approval.code).toBe(0);

    const exported = await runCli(
      ["baselines", "export", "--project", PROJECT_ID, "--route", SUPPORT, "--viewport", "desktop", "--out", bundleDir, "--json"],
      { env: cliEnv(storeDir) },
    );
    expect(exported.code).toBe(0);

    // The bundle carries the approved snapshot, not merely the approved image.
    const manifest = JSON.parse(
      await readFile(path.join(bundleDir, "uiproof-baselines.json"), "utf8"),
    ) as { scopes: Array<{ versions: Array<{ quality?: { fingerprints: string[]; runnerVersion: string; violationCount: number } }> }> };
    // Every version the bundle carries has a snapshot (the store accumulates one approval per
    // run of this test file, and each one recorded what it measured).
    const versionsWithSnapshots = manifest.scopes.flatMap((scope) => scope.versions).filter((version) => version.quality);
    expect(versionsWithSnapshots.length).toBeGreaterThan(0);
    const snapshot = versionsWithSnapshots.at(-1)!.quality!;
    expect(snapshot.fingerprints.length).toBeGreaterThan(0);
    expect(snapshot.violationCount).toBe(snapshot.fingerprints.length);
    expect(snapshot.runnerVersion.length).toBeGreaterThan(0);

    const imported = await runCli(
      ["baselines", "import", "--from", bundleDir, "--activate", "--project", PROJECT_ID, "--route", SUPPORT, "--viewport", "desktop", "--json"],
      { env: cliEnv(portableStoreDir) },
    );
    expect(imported.code).toBe(0);
    expect(imported.json?.accessibilitySnapshots).toBe(versionsWithSnapshots.length);

    // Same page, same policy, two stores: the imported reference classifies identically.
    const local = await runCli(
      ["audit", ...route(SUPPORT, ["--viewport", "desktop", "--fail-on", "serious", "--new-only", "--json"])],
      { env: cliEnv(storeDir) },
    );
    const portable = await runCli(
      ["audit", ...route(SUPPORT, ["--viewport", "desktop", "--fail-on", "serious", "--new-only", "--json"])],
      { env: cliEnv(portableStoreDir) },
    );
    expect(local.code).toBe(0);
    expect(portable.code).toBe(0);
    const localReport = reportOf(local);
    const portableReport = reportOf(portable);
    expect(portableReport.newFindingFingerprints).toEqual([]);
    expect(portableReport.knownFindingFingerprints).toEqual(localReport.knownFindingFingerprints);
    expect(portableReport.resolvedFindingFingerprints).toEqual(localReport.resolvedFindingFingerprints);
    expect(portableReport.references[0].fingerprints).toEqual(localReport.references[0].fingerprints);

    await app.restoreQuality();
  }, 300_000);

  it("answers an infrastructure failure when the page refuses the scanner, and persists nothing", async () => {
    const store = path.join(scratch, "scanner-store");
    await mkdir(store, { recursive: true });
    const run = await runCli(
      ["audit", ...route(CSP, ["--viewport", "desktop", "--fail-on", "serious", "--json"])],
      { env: cliEnv(store) },
    );

    expect(run.code).toBe(2);
    const error = run.json?.error as { code: string; message: string };
    expect(error.code).toBe("quality_unavailable");
    expect(error.message).toMatch(/axe-core could not be injected|Content Security Policy/i);
    // No report on disk: "we could not scan" must never be reviewable as a clean scan.
    await expect(readFile(path.join(store, "audits"), "utf8")).rejects.toThrow();
    expect(run.json?.reportPath ?? null).toBeNull();
  }, 120_000);
});
