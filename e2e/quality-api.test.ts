import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2eServer, type StartedE2eServer } from "./support/e2e-server";
import {
  startExampleApp,
  writeProjectConfig,
  type ExampleApp,
  type ProjectRegistration,
} from "./support/example-app";

/**
 * The quality API, end to end — the endpoints the dashboard's audit panel drives, against
 * an application UIProof did not write.
 *
 * The suite walks the exact contract the dashboard depends on:
 *
 *   1. run an audit of a registered route and get measurements plus evidence links
 *   2. change the application's real UI and see findings grouped by impact, layout
 *      defects only at the narrow viewport, and evidence behind every measurement
 *   3. read the audit history back, newest first
 *   4. refuse what must be refused — cross-site requests, unknown projects, bad policy
 *      and viewport input, and path traversal on the evidence route
 *
 * Every number asserted here comes from a real Chromium capture of the running
 * application.
 */

const PROJECT_ID = "example-app";
const ROUTE_ID = "support";
const SCOPE_KEY = `project:${PROJECT_ID}/${ROUTE_ID}`;

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly text: string;
}

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
}

interface AuditViewportReport {
  viewport: { id: string; label: string; width: number; height: number };
  accessibility: {
    counts: Record<string, number>;
    needsReview: number;
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
  createdAt: string;
  verdict: {
    status: string;
    failures: Array<{ kind: string; code: string; message: string; count: number; evidence: string[] }>;
    notes: string[];
  };
  viewports: AuditViewportReport[];
  references: unknown[];
  newFindingFingerprints: string[];
  knownFindingFingerprints: string[];
  resolvedFindingFingerprints: string[];
}

interface AuditSummary {
  id: string;
  createdAt: string;
  status: string;
  scopeKey: string;
  label: string;
  viewportIds: string[];
  counts: Record<string, number>;
  totalFindings: number;
  needsReview: number;
  responsiveFindings: number;
  newFindings: number;
}

function viewportOf(report: AuditReport, id: string): AuditViewportReport {
  const found = report.viewports.find((entry) => entry.viewport.id === id);
  if (!found) throw new Error(`No ${id} viewport in the audit report`);
  return found;
}

describe("quality API", () => {
  let app: ExampleApp;
  let uiproof: StartedE2eServer;
  let base = "";
  let cleanReport: AuditReport;

  async function api(pathname: string, init?: RequestInit): Promise<ApiResult> {
    const response = await fetch(`${base}${pathname}`, { cache: "no-store", ...init });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  }

  /** A same-origin, same-site request — what the console itself sends. */
  function localInit(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    };
  }

  /** Runs an audit of the registered route; extra body fields override the defaults. */
  function audit(body: Record<string, unknown> = {}) {
    return api(
      "/api/quality/audit",
      localInit({ source: { kind: "project", projectId: PROJECT_ID, routeId: ROUTE_ID }, ...body }),
    );
  }

  async function evidence(pathname: string): Promise<{ status: number; contentType: string; bytes: number }> {
    const response = await fetch(`${base}${pathname}`, { cache: "no-store" });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes: buffer.byteLength,
    };
  }

  let dataDir = "";

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [5331, 5332, 5333, 5334] });

    // The data directory holds the registration file the server reads on every request,
    // so it must outlive the server — it is cleaned up in afterAll.
    dataDir = path.join(os.tmpdir(), `uiproof-quality-api-${randomUUID()}`);
    const configPath = path.join(dataDir, "uiproof.config.json");
    const registration: ProjectRegistration = {
      id: PROJECT_ID,
      name: "Example app",
      origin: app.url,
      routes: [{ id: ROUTE_ID, name: "Contact support", path: "/support" }],
    };
    await writeProjectConfig(configPath, [registration]);

    uiproof = await startE2eServer({
      label: "UIProof (quality API)",
      dataDir,
      portCandidates: [3321, 3322, 3323, 3324],
      env: { UIPROOF_PROJECTS_FILE: configPath },
    });
    base = uiproof.runtime.url;
  }, 240_000);

  afterAll(async () => {
    await uiproof?.stop().catch(() => undefined);
    await app?.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("1. audits a registered route and serves the evidence behind every measurement", async () => {
    const result = await audit();
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const { report, reportPath } = result.body as unknown as { report: AuditReport; reportPath: string };
    expect(reportPath).toContain(report.id);
    expect(report.verdict.status).toBe("pass");
    expect(report.verdict.failures).toEqual([]);
    expect(report.viewports.map((entry) => entry.viewport.id).sort()).toEqual(["desktop", "mobile", "tablet"]);

    for (const entry of report.viewports) {
      expect(entry.accessibility.totalFindings).toBe(0);
      expect(entry.accessibility.findings).toEqual([]);
      expect(entry.responsive.findings).toEqual([]);
      expect(entry.responsive.documentOverflowPx).toBe(0);
    }

    // The table that is wider than a phone is a deliberate scroller: contained evidence at
    // mobile, never a defect.
    const mobile = viewportOf(report, "mobile");
    expect(mobile.responsive.contained.length).toBeGreaterThan(0);
    for (const contained of mobile.responsive.contained) {
      expect(contained.containedInScroller).toBe(true);
      expect(contained.scrollContainer).toContain("table-scroll");
    }

    // Every measurement links to the screenshot it was taken from, and the link works.
    for (const entry of report.viewports) {
      expect(entry.screenshot.url).toBe(`/api/audits/${report.id}/${entry.viewport.id}.png`);
      const png = await evidence(entry.screenshot.url);
      expect(png.status, entry.screenshot.url).toBe(200);
      expect(png.contentType).toBe("image/png");
      expect(png.bytes).toBeGreaterThan(1000);
    }

    // The stored report is the report that was returned, readable both as a document and
    // as the raw evidence file.
    const stored = await api(`/api/audits/${report.id}`);
    expect(stored.status).toBe(200);
    expect((stored.body as { report: AuditReport }).report).toEqual(report);

    const raw = await evidence(`/api/audits/${report.id}/audit.json`);
    expect(raw.status).toBe(200);
    expect(raw.contentType).toContain("application/json");

    cleanReport = report;
  }, 120_000);

  it("2. a real code change produces findings by impact and layout defects only at the narrow viewport", async () => {
    await app.applyQualityDefects();
    const result = await audit();
    expect(result.status).toBe(200);
    const { report } = result.body as unknown as { report: AuditReport };
    expect(report.verdict.status).toBe("fail");
    expect(report.id).not.toBe(cleanReport.id);

    // Findings carry structured evidence — rule, element, markup, remediation — never a score.
    const findings = viewportOf(report, "desktop").accessibility.findings;
    for (const finding of findings) {
      expect(finding.rule.length).toBeGreaterThan(0);
      expect(finding.selector.length).toBeGreaterThan(0);
      expect(finding.html.length).toBeGreaterThan(0);
      expect(finding.helpUrl).toMatch(/^https:\/\//);
    }
    const byRule = new Map(findings.map((finding) => [finding.rule, finding]));
    expect(byRule.get("label")?.impact).toBe("critical");
    expect(byRule.get("label")?.selector).toContain("#support-email");
    expect(byRule.get("select-name")?.impact).toBe("critical");
    expect(byRule.get("button-name")?.impact).toBe("critical");

    // The measured contrast failure is a serious violation; the undecidable glyph is a
    // question, reported beside it and never counted as a failure.
    const contrast = findings.find(
      (finding) => finding.rule === "color-contrast" && finding.status === "violation",
    );
    expect(contrast?.impact).toBe("serious");
    const review = findings.find((finding) => finding.status === "needs-review");
    expect(review?.rule).toBe("color-contrast");

    // Layout by viewport: the 720px banner escapes only the phone, and the deliberate
    // table scroller stays evidence rather than a defect everywhere.
    const mobile = viewportOf(report, "mobile");
    expect(mobile.responsive.documentOverflowPx).toBeGreaterThan(300);
    const banner = mobile.responsive.findings.find((finding) => finding.selector.includes("maintenance-banner"));
    expect(banner?.containedInScroller).toBe(false);
    expect(banner?.scrollContainer).toBeNull();
    expect(mobile.responsive.contained.length).toBeGreaterThan(0);
    expect(mobile.responsive.findings.map((finding) => finding.selector).join(" ")).not.toContain("table-scroll");

    const desktop = viewportOf(report, "desktop");
    expect(desktop.responsive.findings).toEqual([]);
    expect(desktop.responsive.documentOverflowPx).toBe(0);

    // The verdict's failures name the measured problems and the evidence behind them.
    const codes = report.verdict.failures.map((failure) => failure.code);
    expect(codes).toContain("responsive.document-overflow");
    expect(codes).toContain("responsive.element-overflow");
    const layoutFailure = report.verdict.failures.find(
      (failure) => failure.code === "responsive.element-overflow",
    );
    expect(layoutFailure?.evidence.join(" ")).toContain("maintenance-banner");

    // Evidence links work for a failing audit too.
    for (const entry of report.viewports) {
      const png = await evidence(entry.screenshot.url);
      expect(png.status, entry.screenshot.url).toBe(200);
      expect(png.bytes).toBeGreaterThan(1000);
    }

    await app.restoreQuality();
  }, 120_000);

  it("3. the audit history lists stored audits, newest first", async () => {
    const result = await api("/api/audits");
    expect(result.status).toBe(200);
    const { audits } = result.body as unknown as { audits: AuditSummary[] };
    expect(audits.length).toBeGreaterThanOrEqual(2);

    const times = audits.map((audit) => Date.parse(audit.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const latest = audits[0];
    expect(latest.scopeKey).toBe(SCOPE_KEY);
    expect(latest.label).toBe("Example app · Contact support");
    expect(latest.viewportIds.sort()).toEqual(["desktop", "mobile", "tablet"]);
    expect(typeof latest.counts).toBe("object");
    expect(typeof latest.needsReview).toBe("number");
    expect(typeof latest.responsiveFindings).toBe("number");
    expect(typeof latest.newFindings).toBe("number");

    // The summary agrees with the stored report it summarizes.
    const detail = await api(`/api/audits/${latest.id}`);
    const report = (detail.body as { report: AuditReport }).report;
    expect(report.id).toBe(latest.id);
    expect(latest.totalFindings).toBe(
      report.viewports.reduce((total, entry) => total + entry.accessibility.totalFindings, 0),
    );

    const limited = await api("/api/audits?limit=1");
    expect((limited.body as { audits: AuditSummary[] }).audits).toHaveLength(1);
  }, 60_000);

  it("4. refuses cross-site requests, unknown projects, bad input and path traversal", async () => {
    // A hostile page cannot drive the audit engine.
    const crossSite = await api("/api/quality/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ source: { kind: "project", projectId: PROJECT_ID, routeId: ROUTE_ID } }),
    });
    expect(crossSite.status).toBe(403);
    expect((crossSite.body as { error: { code: string } }).error.code).toBe("untrusted_request");

    // An unregistered project is refused before a browser is ever launched.
    const unknown = await audit({ source: { kind: "project", projectId: "not-registered", routeId: "home" } });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { error: { code: string } }).error.code).toBe("project_not_registered");

    const badPolicy = await audit({ policy: { failOn: "everything" } });
    expect(badPolicy.status).toBe(400);
    expect((badPolicy.body as { error: { code: string } }).error.code).toBe("quality_policy_invalid");

    const badViewports = await audit({ viewports: ["gigantic"] });
    expect(badViewports.status).toBe(400);
    expect((badViewports.body as { error: { code: string } }).error.code).toBe("invalid_viewport");

    // The evidence route validates both path segments before the filesystem is touched:
    // traversal input is refused, and the registration file it aims at is never served.
    const traversal = await api(`/api/audits/${cleanReport.id}/%2e%2e%2f%2e%2e%2fuiproof.config.json`);
    expect(traversal.status).toBeGreaterThanOrEqual(400);
    expect(traversal.text).not.toContain(PROJECT_ID);

    const wrongFile = await api(`/api/audits/${cleanReport.id}/audit.json.bak`);
    expect(wrongFile.status).toBe(400);
    expect((wrongFile.body as { error: { code: string } }).error.code).toBe("invalid_report_id");

    // A well-formed but unknown audit id reports missing, not found.
    const missing = await api("/api/audits/audit-00000000/desktop.png");
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe("report_not_found");
  }, 60_000);
});
