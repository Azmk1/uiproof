import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveBaseline, readBaselineImage, readBaselineManifest } from "@/lib/compare/baselines";
import { runComparison } from "@/lib/compare/engine";
import type { RegisteredProject } from "@/lib/compare/types";
import { issuesFromQualityReport } from "@/lib/diagnosis/context";
import { runQualityAudit } from "@/lib/quality/audit";
import { readAudit } from "@/lib/quality/storage";
import { runRepair } from "@/lib/repair/engine";
import { readRepair, readRepairArtifact, repairPatchName } from "@/lib/repair/storage";
import type { RepairMeasurement, RepairPageMeasurement } from "@/lib/repair/types";
import { startRepairApp, type RepairApp } from "./support/repair-app";
import {
  offeredIssueKeys,
  proposalJson,
  replaceLinePatch,
  startStubModel,
  type StubModel,
} from "./support/stub-model";

/**
 * Phase 8, end to end, on a real application.
 *
 * Every measurement in this file is real: Chromium captures the fixture over HTTP, axe-core
 * scans the live DOM, the responsive probe measures the real layout, and the visual half
 * diffs real PNGs against an approved baseline. Only the **model** is a test double — a
 * deterministic OpenAI-compatible stub that returns a patch chosen by the test. That proves
 * the pipeline's behaviour, not a model's quality, which is exactly the distinction the
 * phase brief asks to keep.
 *
 * The fixture has four independent, deliberate defects (a missing accessible name, a
 * contrast failure, mobile overflow and a visual regression in a separate view). Each test
 * takes one of them through the whole loop: audit → proposal → isolated patch → build and
 * tests → re-measurement → verdict → stored evidence, and then checks that the developer's
 * own source tree and approved baseline are exactly as they were.
 */

const SANDBOX_URL = "http://127.0.0.1:4199";

let dataDir: string;
let previousDataDir: string | undefined;
let app: RepairApp | null = null;
let stub: StubModel | null = null;

beforeEach(async () => {
  previousDataDir = process.env.UIPROOF_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-repair-data-"));
  process.env.UIPROOF_DATA_DIR = dataDir;
});

afterEach(async () => {
  await stub?.stop();
  await app?.stop();
  stub = null;
  app = null;
  if (previousDataDir === undefined) delete process.env.UIPROOF_DATA_DIR;
  else process.env.UIPROOF_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function projectFor(target: RepairApp): RegisteredProject {
  return {
    id: "repair-app",
    name: "Repair fixture",
    origin: target.url,
    routes: [
      { id: "support", name: "Support", path: "/", url: `${target.url}/` },
      { id: "manual", name: "Manual", path: "/manual", url: `${target.url}/manual` },
    ],
    modes: ["capture", "baseline"],
    defaultMode: "capture",
    allowedOrigins: [],
    sourceDir: target.dir,
    repair: {
      sandbox: { command: ["node", "server.mjs"], url: SANDBOX_URL, readyPath: "/healthz", env: {} },
      build: ["node", "scripts/check-build.mjs"],
      test: ["node", "scripts/check-tests.mjs"],
      allow: ["views/**"],
      guardRoutes: ["manual"],
      entryFiles: ["views/index.html"],
    },
  };
}

function modelEnv(model: StubModel): Record<string, string> {
  return {
    UIPROOF_AI_API_KEY: "stub-key",
    UIPROOF_AI_BASE_URL: model.baseUrl,
    UIPROOF_AI_MODEL: "stub-model",
  };
}

async function auditMobile(project: RegisteredProject) {
  const { report } = await runQualityAudit({
    source: { kind: "project", projectId: project.id, routeId: "support" },
    viewports: ["mobile"],
    origin: "http://127.0.0.1",
    projects: [project],
    persist: true,
  });
  const { issues } = issuesFromQualityReport(report);
  return { report, issues };
}

function issueOf(
  issues: readonly { key: string; kind: string }[],
  predicate: (key: string) => boolean,
): { key: string; kind: string } {
  const found = issues.find((issue) => predicate(issue.key));
  if (!found) throw new Error(`The audit did not measure the expected issue. Keys: ${issues.map((issue) => issue.key).join(", ")}`);
  return found;
}

async function repairRun(
  project: RegisteredProject,
  target: { readonly auditId?: string; readonly reportId?: string },
  model: StubModel,
  maxAttempts = 1,
) {
  return runRepair({
    ...target,
    lookupProject: () => ({ project, sourceDir: project.sourceDir ?? null, from: "e2e registration" }),
    maxAttempts,
    env: modelEnv(model),
  });
}

function pageOf(
  measurement: RepairMeasurement,
  routeId: string,
  viewportId: string,
): RepairPageMeasurement {
  const page = measurement.pages.find((entry) => entry.routeId === routeId && entry.viewportId === viewportId);
  if (!page) throw new Error(`No ${routeId}@${viewportId} measurement`);
  return page;
}

describe("autonomous repair engine", () => {
  it("fixes a missing accessible name on a second, evidence-driven attempt without touching the original", async () => {
    app = await startRepairApp();
    const project = projectFor(app);
    const { report, issues } = await auditMobile(project);
    const issue = issueOf(issues, (key) => key.startsWith("a11y:label@"));
    const original = await app.readView();

    const firstAttempt = replaceLinePatch(
      "views/index.html",
      original,
      "      <h1>Contact support</h1>",
      ["      <h1>Contact support</h1>", "      <!-- a comment changes the file but nothing measurable -->"],
    );
    const secondAttempt = replaceLinePatch(
      "views/index.html",
      original,
      '          <input id="email" type="email" autocomplete="email" />',
      ['          <input id="email" type="email" autocomplete="email" />', '          <label for="email">Email</label>'],
    );

    let call = 0;
    stub = await startStubModel(({ user }) => {
      call += 1;
      const offered = offeredIssueKeys(user);
      const key = offered.find((entry) => entry.startsWith("a11y:label@"));
      if (!key) throw new Error(`No label issue was offered: ${offered.join(", ")}`);
      return proposalJson({ issueKey: key, patch: call === 1 ? firstAttempt : secondAttempt });
    });

    const { repair, path: storedPath } = await repairRun(project, { auditId: report.id }, stub, 2);

    expect(repair.status).toBe("verified");
    expect(repair.verifiedAttempt).toBe(2);
    expect(repair.attempts).toHaveLength(2);
    expect(repair.attempts[0].verdict).toBe("rejected");
    expect(repair.attempts[0].verification?.reasons.join(" ")).toMatch(/did not measurably change/);
    expect(repair.attempts[1].verdict).toBe("verified");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].user).toContain("Previous attempt 1 was REJECTED");

    const before = pageOf(repair.before, "support", "mobile");
    const after = pageOf(repair.attempts[1].verification!.after!, "support", "mobile");
    expect(before.accessibility.fingerprints).toContain(issue.key.slice("a11y:".length));
    expect(after.accessibility.fingerprints).not.toContain(issue.key.slice("a11y:".length));
    expect(after.accessibility.critical).toBe(before.accessibility.critical - 1);

    // The guard route was measured before and after and did not gain anything.
    const guardBefore = pageOf(repair.before, "manual", "desktop");
    const guardAfter = pageOf(repair.attempts[1].verification!.after!, "manual", "desktop");
    expect(guardAfter.accessibility.serious + guardAfter.accessibility.critical).toBe(
      guardBefore.accessibility.serious + guardBefore.accessibility.critical,
    );

    // The developer's tree is byte-for-byte what it was; the fix exists only in the record.
    expect(repair.originalUnchanged).toBe(true);
    expect(await app.readView()).toBe(original);
    expect(await app.readView()).not.toContain('for="email"');
    expect(repair.revision.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(repair.revisionAfter?.digest).toBe(repair.revision.digest);

    expect(storedPath).not.toBeNull();
    const stored = await readRepair(repair.id);
    expect(stored?.status).toBe("verified");
    const patch = await readRepairArtifact(repair.id, repairPatchName(2));
    expect(patch.toString("utf8")).toContain("<label for=\"email\">Email</label>");

    // The stored audit is untouched by the repair.
    const storedAudit = await readAudit(report.id);
    expect(storedAudit?.viewports[0].accessibility.totalFindings).toBe(report.viewports[0].accessibility.totalFindings);
  }, 240_000);

  it("fixes an insufficient-contrast defect while leaving pre-existing findings alone", async () => {
    app = await startRepairApp();
    const project = projectFor(app);
    const { report, issues } = await auditMobile(project);
    const contrast = issueOf(issues, (key) => key.startsWith("a11y:color-contrast@"));
    const label = issues.find((entry) => entry.key.startsWith("a11y:label@")) ?? null;
    expect(label).not.toBeNull();
    const original = await app.readView();

    const patch = replaceLinePatch(
      "views/index.html",
      original,
      '      <p class="note" style="color: #9a9a9a">Support replies arrive within one business day.</p>',
      ['      <p class="note" style="color: #595959">Support replies arrive within one business day.</p>'],
    );
    stub = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.startsWith("a11y:color-contrast@"));
      if (!key) throw new Error("No contrast issue was offered");
      return proposalJson({ issueKey: key, patch });
    });

    const { repair } = await repairRun(project, { auditId: report.id }, stub, 1);
    expect(repair.status).toBe("verified");
    expect(repair.attempts[0].verification?.verdict).toBe("verified");

    const before = pageOf(repair.before, "support", "mobile");
    const after = pageOf(repair.attempts[0].verification!.after!, "support", "mobile");
    expect(before.accessibility.fingerprints).toContain(contrast.key.slice("a11y:".length));
    expect(after.accessibility.fingerprints).not.toContain(contrast.key.slice("a11y:".length));
    // The unrelated missing-name defect was already there; it must still be there and must
    // not be reported as a regression.
    expect(after.accessibility.fingerprints).toContain(label!.key.slice("a11y:".length));
    expect(repair.attempts[0].verification?.regressions.filter((check) => check.status === "regression")).toEqual([]);
  }, 240_000);

  it("fixes mobile horizontal overflow and reports the measured before/after overflow", async () => {
    app = await startRepairApp();
    const project = projectFor(app);
    const { report, issues } = await auditMobile(project);
    issueOf(issues, (key) => key.startsWith("responsive:"));
    const original = await app.readView();

    const patch = replaceLinePatch(
      "views/index.html",
      original,
      '      <div class="banner" id="maintenance-banner" style="width: 720px">',
      ['      <div class="banner" id="maintenance-banner" style="max-width: 100%">'],
    );
    stub = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.startsWith("responsive:"));
      if (!key) throw new Error("No responsive issue was offered");
      return proposalJson({ issueKey: key, patch });
    });

    const { repair } = await repairRun(project, { auditId: report.id }, stub, 1);
    expect(repair.status).toBe("verified");

    const before = pageOf(repair.before, "support", "mobile");
    const after = pageOf(repair.attempts[0].verification!.after!, "support", "mobile");
    expect(before.layout.documentOverflowPx).toBeGreaterThan(100);
    expect(before.layout.defects.length).toBeGreaterThan(0);
    expect(after.layout.documentOverflowPx).toBeLessThanOrEqual(1);
    expect(after.layout.defects).toEqual([]);
    expect(repair.attempts[0].verification?.targets[0].status).toBe("fixed");
  }, 240_000);

  it("repairs a visual regression against an approved baseline without changing the baseline", async () => {
    app = await startRepairApp();
    const project = projectFor(app);

    await app.useView("visual.good");
    const capture = await runComparison({
      source: { kind: "project", projectId: project.id, routeId: "support" },
      viewportId: "desktop",
      mode: "capture",
      origin: "http://127.0.0.1",
      projects: [project],
    });
    const approved = await approveBaseline({
      scope: { kind: "project", projectId: project.id, routeId: "support" },
      viewportId: "desktop",
      sourceReportId: capture.id,
      note: "Phase 8 fixture baseline",
    });
    const manifestBefore = JSON.stringify(await readBaselineManifest(
      { kind: "project", projectId: project.id, routeId: "support" },
      "desktop",
    ));
    const baselinePngBefore = await readBaselineImage(
      { kind: "project", projectId: project.id, routeId: "support" },
      "desktop",
      `${approved.version.id}.png`,
    );

    await app.useView("visual.broken");
    const regression = await runComparison({
      source: { kind: "project", projectId: project.id, routeId: "support" },
      viewportId: "desktop",
      mode: "baseline",
      origin: "http://127.0.0.1",
      projects: [project],
    });
    expect(regression.status).toBe("regression");

    const original = await app.readView();
    const patch = replaceLinePatch(
      "views/index.html",
      original,
      '      <section class="card" style="padding: 8px 4px; background: #ffffff">',
      ['      <section class="card" style="padding: 24px 16px; background: #ffffff">'],
    );
    stub = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.startsWith("visual:"));
      if (!key) throw new Error("No visual issue was offered");
      return proposalJson({ issueKey: key, patch });
    });

    const { repair } = await repairRun(project, { reportId: regression.id }, stub, 1);
    expect(repair.status).toBe("verified");

    const before = pageOf(repair.before, "support", "desktop");
    const after = pageOf(repair.attempts[0].verification!.after!, "support", "desktop");
    expect(before.visual.status).toBe("regressed");
    expect(after.visual.status).toBe("match");
    expect(after.visual.changedPixels).toBe(0);

    expect(JSON.stringify(await readBaselineManifest(
      { kind: "project", projectId: project.id, routeId: "support" },
      "desktop",
    ))).toBe(manifestBefore);
    const baselinePngAfter = await readBaselineImage(
      { kind: "project", projectId: project.id, routeId: "support" },
      "desktop",
      `${approved.version.id}.png`,
    );
    expect(createHash("sha256").update(baselinePngAfter).digest("hex")).toBe(
      createHash("sha256").update(baselinePngBefore).digest("hex"),
    );

    expect(repair.originalUnchanged).toBe(true);
    expect(await app.readView()).toBe(original);
  }, 240_000);

  it("rejects a patch that fixes the target but introduces a serious accessibility regression", async () => {
    app = await startRepairApp();
    const project = projectFor(app);
    const { report, issues } = await auditMobile(project);
    const label = issueOf(issues, (key) => key.startsWith("a11y:label@"));
    const original = await app.readView();

    const h1Hunk = replaceLinePatch(
      "views/index.html",
      original,
      "      <h1>Contact support</h1>",
      ['      <h1 style="color: #f0f0f0">Contact support</h1>'],
    );
    const labelHunk = replaceLinePatch(
      "views/index.html",
      original,
      '          <input id="email" type="email" autocomplete="email" />',
      ['          <input id="email" type="email" autocomplete="email" />', '          <label for="email">Email</label>'],
    );
    // Two hunks in one file, in ascending line order.
    const patch = [
      "--- a/views/index.html",
      "+++ b/views/index.html",
      h1Hunk.split("\n").slice(2).join("\n"),
      labelHunk.split("\n").slice(2).join("\n"),
    ].join("\n");

    stub = await startStubModel(() => proposalJson({ issueKey: label.key, patch }));
    const { repair } = await repairRun(project, { auditId: report.id }, stub, 1);

    expect(repair.status).toBe("rejected");
    expect(repair.attempts[0].verdict).toBe("rejected");
    expect(repair.attempts[0].verification?.targets[0].status).toBe("fixed");
    const reasons = repair.attempts[0].verification?.reasons.join(" ") ?? "";
    expect(reasons).toMatch(/new serious\/critical finding/);
    expect(repair.originalUnchanged).toBe(true);
    expect(await app.readView()).toBe(original);
  }, 240_000);
});
