import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activateBaselineVersion,
  approveBaseline,
  readActiveBaseline,
  readBaselineImage,
  readBaselineManifest,
  toBaselineReference,
} from "./baselines";
import { ComparisonError } from "./errors";
import { ARTIFACT_FILENAMES, REPORT_FILENAME, resolveReportDir } from "./storage-paths";
import type { BaselineScope, ComparisonReport, RunSource } from "./types";

/**
 * The store is exercised against a real temporary data directory: real PNG bytes on
 * disk, real manifest rewrites, real concurrent approvals and a real cross-process lock.
 * Nothing here is stubbed.
 *
 * Phase 3 added a second kind of scope (a registered project route), so most tests run
 * twice: once for a demo target, whose storage layout must not move, and once for a
 * project route, whose baselines live under their own namespace.
 */

const DATA_DIR = path.join(os.tmpdir(), `uiproof-baselines-${randomUUID()}`);

const demo = (targetId: string): BaselineScope => ({ kind: "demo", targetId });
const project = (projectId: string, routeId: string): BaselineScope => ({ kind: "project", projectId, routeId });

const INVOICE = demo("invoice-summary");
const CONTROL = demo("baseline-control");
const EXAMPLE_HOME = project("example-app", "home");
const EXAMPLE_CHECKOUT = project("example-app", "checkout");
const OTHER_PROJECT = project("other-app", "home");

function solidPng(width: number, height: number, colour: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = colour[0];
    png.data[i + 1] = colour[1];
    png.data[i + 2] = colour[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function sourceFor(input: {
  readonly kind: "demo" | "project";
  readonly scopeKey: string;
  readonly label: string;
  readonly projectId?: string;
  readonly routeId?: string;
  readonly path: string;
}): RunSource {
  return {
    kind: input.kind,
    scopeKey: input.scopeKey,
    label: input.label,
    projectId: input.projectId ?? null,
    projectName: input.kind === "project" ? "Example app" : null,
    routeId: input.routeId ?? null,
    routeName: input.kind === "project" ? "Home" : null,
    origin: input.kind === "project" ? "http://127.0.0.1:4173" : "http://127.0.0.1:3000",
    path: input.path,
    blockedRequests: 0,
  };
}

function reportFor(input: {
  id: string;
  scopeKey: string;
  label: string;
  kind: "demo" | "project";
  targetId: string;
  path: string;
  viewportId: string;
  viewportLabel: string;
}): ComparisonReport {
  const createdAt = new Date().toISOString();
  const artifact = { url: "/api/artifacts/x/y.png", bytes: 1, width: 4, height: 3 };
  return {
    id: input.id,
    createdAt,
    status: "pass",
    mode: "fixture",
    variantId: null,
    baseline: null,
    source: sourceFor({
      kind: input.kind,
      scopeKey: input.scopeKey,
      label: input.label,
      projectId: input.kind === "project" ? input.scopeKey.slice("project:".length).split("/")[0] : undefined,
      routeId: input.kind === "project" ? input.scopeKey.slice("project:".length).split("/")[1] : undefined,
      path: input.path,
    }),
    target: {
      id: input.targetId,
      label: input.label,
      baselinePath: "/demo/baseline",
      currentPath: input.path,
    },
    viewport: { id: input.viewportId, label: input.viewportLabel, width: 4, height: 3, deviceScaleFactor: 1 },
    metrics: {
      changedPixels: 0,
      comparedPixels: 12,
      changePercentage: 0,
      pixelThreshold: 0.1,
      maxDiffPercent: 0.1,
      dimensionsChanged: false,
    },
    artifacts: { baseline: artifact, current: artifact, diff: artifact },
    engine: {
      provider: "playwright",
      comparator: "pixelmatch",
      browser: "chromium",
      captureMs: 1,
      compareMs: 1,
      totalMs: 2,
    },
  };
}

interface SeedRunInput {
  readonly id: string;
  readonly scope?: BaselineScope;
  readonly label?: string;
  readonly path?: string;
  readonly viewportId?: string;
  readonly viewportLabel?: string;
  readonly png?: Buffer;
}

function scopeKeyOf(scope: BaselineScope): string {
  return scope.kind === "demo" ? `demo:${scope.targetId}` : `project:${scope.projectId}/${scope.routeId}`;
}

/** Writes a run directory the way the engine does, so approvals read real stored data. */
async function seedRun(input: SeedRunInput): Promise<{ report: ComparisonReport; png: Buffer }> {
  const scope = input.scope ?? INVOICE;
  const isProject = scope.kind === "project";
  const report = reportFor({
    id: input.id,
    kind: scope.kind,
    scopeKey: scopeKeyOf(scope),
    label: input.label ?? (isProject ? "Example app · Home" : "Invoice summary card"),
    targetId: scope.kind === "demo" ? scope.targetId : scopeKeyOf(scope),
    path: input.path ?? (isProject ? "/" : "/demo/current"),
    viewportId: input.viewportId ?? "desktop",
    viewportLabel: input.viewportLabel ?? "Desktop",
  });
  const png = input.png ?? solidPng(8, 6, [200, 30, 30]);
  const directory = resolveReportDir(report.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ARTIFACT_FILENAMES.baseline), solidPng(8, 6, [20, 20, 20]));
  await writeFile(path.join(directory, ARTIFACT_FILENAMES.current), png);
  await writeFile(path.join(directory, ARTIFACT_FILENAMES.diff), solidPng(8, 6, [255, 255, 255]));
  await writeFile(path.join(directory, REPORT_FILENAME), JSON.stringify(report, null, 2), "utf8");
  return { report, png };
}

async function versionFiles(scope: BaselineScope = INVOICE, viewportId = "desktop"): Promise<string[]> {
  const dir =
    scope.kind === "demo"
      ? path.join(DATA_DIR, "baselines", scope.targetId, viewportId, "versions")
      : path.join(DATA_DIR, "baselines", "projects", scope.projectId, scope.routeId, viewportId, "versions");
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

function manifestPathOf(scope: BaselineScope, viewportId = "desktop"): string {
  return scope.kind === "demo"
    ? path.join(DATA_DIR, "baselines", scope.targetId, viewportId, "manifest.json")
    : path.join(DATA_DIR, "baselines", "projects", scope.projectId, scope.routeId, viewportId, "manifest.json");
}

async function approveFromRun(runId: string, scope: BaselineScope = INVOICE, viewportId = "desktop") {
  return approveBaseline({ scope, viewportId, sourceReportId: runId });
}

beforeAll(async () => {
  process.env.UIPROOF_DATA_DIR = DATA_DIR;
  await mkdir(DATA_DIR, { recursive: true });
});

afterAll(async () => {
  delete process.env.UIPROOF_DATA_DIR;
  await rm(DATA_DIR, { recursive: true, force: true });
});

describe("approveBaseline", () => {
  it("starts from nothing and answers null rather than inventing a baseline", async () => {
    expect(await readBaselineManifest(INVOICE, "tablet")).toBeNull();
    expect(await readActiveBaseline(INVOICE, "tablet")).toBeNull();
    expect(await readBaselineManifest(EXAMPLE_HOME, "desktop")).toBeNull();
  });

  it("adopts a stored run's current.png as the first approved version", async () => {
    const runId = `run-${randomUUID()}`;
    const { png } = await seedRun({ id: runId, viewportId: "desktop" });

    const { manifest, version } = await approveFromRun(runId);

    expect(manifest.activeVersionId).toBe(version.id);
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.revision).toBe(1);
    expect(manifest.scope).toBe("demo");
    expect(version).toMatchObject({
      scope: "demo",
      targetId: "invoice-summary",
      projectId: null,
      routeId: null,
      viewportId: "desktop",
      viewportLabel: "Desktop",
      sourceReportId: runId,
      capturedRoute: "/demo/current",
      width: 8,
      height: 6,
      bytes: png.byteLength,
      note: null,
    });
    expect(version.id.startsWith("bl-")).toBe(true);
    expect(version.imageUrl).toBe(`/api/baselines/invoice-summary/desktop/${version.id}.png`);
    expect(toBaselineReference(version).versionId).toBe(version.id);

    // The stored image is byte-for-byte the capture that was approved.
    const stored = await readBaselineImage(INVOICE, "desktop", `${version.id}.png`);
    expect(Buffer.compare(stored, png)).toBe(0);
    expect(await versionFiles()).toEqual([`${version.id}.png`]);
  });

  it("stores a registered project's baseline under its own namespace", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, scope: EXAMPLE_HOME, viewportId: "desktop", png: solidPng(8, 6, [7, 8, 9]) });

    const { manifest, version } = await approveFromRun(runId, EXAMPLE_HOME);

    expect(manifest.scope).toBe("project");
    expect(manifest.projectId).toBe("example-app");
    expect(manifest.routeId).toBe("home");
    expect(manifest.targetId).toBe("example-app");
    expect(manifest.targetLabel).toBe("Example app · Home");
    expect(version).toMatchObject({
      scope: "project",
      projectId: "example-app",
      routeId: "home",
      routeName: "Home",
      targetId: "example-app",
      capturedRoute: "/",
      origin: "http://127.0.0.1:4173",
    });
    expect(version.imageUrl).toBe(`/api/baselines/projects/example-app/home/desktop/${version.id}.png`);

    // The layout is namespaced, so it can never collide with a demo target directory.
    expect(await versionFiles(EXAMPLE_HOME)).toEqual([`${version.id}.png`]);
    expect(await versionFiles(INVOICE)).not.toContain(`${version.id}.png`);
    expect(Buffer.compare(await readBaselineImage(EXAMPLE_HOME, "desktop", `${version.id}.png`), await readBaselineImage(INVOICE, "desktop", (await readBaselineManifest(INVOICE, "desktop"))!.versions[0].id + ".png"))).not.toBe(0);
  });

  it("records the page state that was approved", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "tablet", path: "/demo/reverted" });
    const { version } = await approveFromRun(runId, INVOICE, "tablet");
    expect(version.capturedRoute).toBe("/demo/reverted");
  });

  it("appends a new version instead of overwriting the approved one", async () => {
    const first = `run-${randomUUID()}`;
    const second = `run-${randomUUID()}`;
    await seedRun({ id: first, viewportId: "mobile", png: solidPng(8, 6, [10, 10, 200]) });
    await seedRun({ id: second, viewportId: "mobile", png: solidPng(8, 6, [10, 200, 10]) });

    const firstApproval = await approveFromRun(first, INVOICE, "mobile");
    const firstBytes = await readBaselineImage(INVOICE, "mobile", `${firstApproval.version.id}.png`);

    const secondApproval = await approveFromRun(second, INVOICE, "mobile");
    const manifest = await readBaselineManifest(INVOICE, "mobile");

    expect(manifest?.versions).toHaveLength(2);
    expect(manifest?.activeVersionId).toBe(secondApproval.version.id);
    expect(manifest?.revision).toBe(2);
    expect(await versionFiles(INVOICE, "mobile")).toHaveLength(2);

    // The older image is untouched: an approval never rewrites history.
    const stillThere = await readBaselineImage(INVOICE, "mobile", `${firstApproval.version.id}.png`);
    expect(Buffer.compare(stillThere, firstBytes)).toBe(0);
    expect(firstApproval.version.id).not.toBe(secondApproval.version.id);
  });

  it("refuses a run that belongs to another target or viewport", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "desktop" });

    await expect(approveFromRun(runId, INVOICE, "mobile")).rejects.toMatchObject({
      code: "baseline_source_mismatch",
      status: 400,
    });
    await expect(approveFromRun(runId, CONTROL, "desktop")).rejects.toMatchObject({
      code: "baseline_source_mismatch",
    });
    expect(await readBaselineManifest(CONTROL, "desktop")).toBeNull();
  });

  it("never lets one project's run become another scope's baseline", async () => {
    const projectRun = `run-${randomUUID()}`;
    const demoRun = `run-${randomUUID()}`;
    await seedRun({ id: projectRun, scope: EXAMPLE_HOME, path: "/" });
    await seedRun({ id: demoRun, scope: INVOICE, path: "/demo/current" });

    // A project run offered for a demo target, a different route, a different project,
    // and the other way round: all refused, all with nothing written.
    await expect(approveFromRun(projectRun, INVOICE)).rejects.toMatchObject({ code: "baseline_source_mismatch" });
    await expect(approveFromRun(projectRun, EXAMPLE_CHECKOUT)).rejects.toMatchObject({
      code: "baseline_source_mismatch",
    });
    await expect(approveFromRun(projectRun, OTHER_PROJECT)).rejects.toMatchObject({
      code: "baseline_source_mismatch",
    });
    await expect(approveFromRun(demoRun, EXAMPLE_HOME)).rejects.toMatchObject({ code: "baseline_source_mismatch" });

    expect(await readBaselineManifest(EXAMPLE_CHECKOUT, "desktop")).toBeNull();
    expect(await readBaselineManifest(OTHER_PROJECT, "desktop")).toBeNull();
    expect(await versionFiles(EXAMPLE_CHECKOUT)).toEqual([]);
    expect(await versionFiles(OTHER_PROJECT)).toEqual([]);
  });

  it("refuses unknown scopes, viewports and missing runs", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId });

    await expect(approveFromRun(runId, demo("../../etc"), "desktop")).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(approveFromRun(runId, project("../../etc", "home"), "desktop")).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(approveFromRun(runId, project("example-app", "../home"), "desktop")).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(approveFromRun(runId, INVOICE, "watch")).rejects.toMatchObject({ code: "invalid_viewport" });
    await expect(
      approveBaseline({ scope: INVOICE, viewportId: "desktop", sourceReportId: `run-${randomUUID()}` }),
    ).rejects.toMatchObject({ code: "report_not_found", status: 404 });
    await expect(
      approveBaseline({ scope: INVOICE, viewportId: "desktop", sourceReportId: "../etc/passwd" }),
    ).rejects.toMatchObject({ code: "invalid_report_id" });
  });

  it("refuses to adopt an undecodable capture", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "desktop", png: Buffer.from("not a png at all") });
    await expect(approveFromRun(runId)).rejects.toMatchObject({ code: "storage_failed" });
    expect(await versionFiles()).not.toContain(expect.stringContaining(runId));
  });

  it("validates the optional note", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "tablet" });
    const withNote = await approveBaseline({
      scope: INVOICE,
      viewportId: "tablet",
      sourceReportId: runId,
      note: "  after the price fix  ",
    });
    expect(withNote.version.note).toBe("after the price fix");
    await expect(
      approveBaseline({ scope: INVOICE, viewportId: "tablet", sourceReportId: runId, note: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_options" });
  });
});

describe("concurrent approvals", () => {
  it("keeps every version instead of losing updates", async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const id = `run-${randomUUID()}`;
        await seedRun({ id, viewportId: "desktop", png: solidPng(8, 6, [index * 40, 80, 80]) });
        return id;
      }),
    );

    const before = (await readBaselineManifest(INVOICE, "desktop"))?.versions.length ?? 0;
    const approvals = await Promise.all(runs.map((runId) => approveFromRun(runId)));
    const manifest = await readBaselineManifest(INVOICE, "desktop");
    const approvedIds = approvals.map((approval) => approval.version.id);

    // Five simultaneous approvals must add five versions — not fewer, and not more.
    expect(manifest?.versions).toHaveLength(before + approvedIds.length);
    expect(new Set(manifest!.versions.map((version) => version.id)).size).toBe(manifest!.versions.length);
    expect(new Set(approvedIds).size).toBe(approvedIds.length);
    expect(manifest?.revision).toBeGreaterThanOrEqual(before + approvedIds.length);
    expect(manifest?.activeVersionId).not.toBeNull();
    expect(approvedIds).toContain(manifest?.activeVersionId);

    // Every manifest row has its image on disk, and no orphan files were left behind.
    const files = await versionFiles();
    expect(files.sort()).toEqual(manifest!.versions.map((version) => `${version.id}.png`).sort());
  });

  it("leaves no lock directory behind after a run of approvals", async () => {
    const lockDir = path.join(DATA_DIR, "baselines", "invoice-summary", "desktop", ".manifest.lock");
    await expect(readdir(lockDir)).rejects.toThrow();
  });
});

describe("activateBaselineVersion", () => {
  it("restores an earlier version without touching any image", async () => {
    const first = `run-${randomUUID()}`;
    const second = `run-${randomUUID()}`;
    await seedRun({ id: first, viewportId: "tablet", png: solidPng(8, 6, [1, 2, 3]) });
    await seedRun({ id: second, viewportId: "tablet", png: solidPng(8, 6, [4, 5, 6]) });
    const historyBefore = (await readBaselineManifest(INVOICE, "tablet"))?.versions.length ?? 0;
    const older = await approveFromRun(first, INVOICE, "tablet");
    const newer = await approveFromRun(second, INVOICE, "tablet");
    const filesBefore = await versionFiles(INVOICE, "tablet");

    const restored = await activateBaselineVersion({
      scope: INVOICE,
      viewportId: "tablet",
      versionId: older.version.id,
    });

    expect(restored.activeVersionId).toBe(older.version.id);
    // Rolling back the active pointer adds no versions and deletes no image.
    expect(restored.versions).toHaveLength(historyBefore + 2);
    expect(restored.revision).toBeGreaterThanOrEqual(3);
    expect(await versionFiles(INVOICE, "tablet")).toEqual(filesBefore);

    const active = await readActiveBaseline(INVOICE, "tablet");
    expect(active?.version.id).toBe(older.version.id);
    expect(Buffer.compare(active!.png, await readBaselineImage(INVOICE, "tablet", `${older.version.id}.png`))).toBe(0);

    // Idempotent: re-activating the active version is not a new revision.
    const again = await activateBaselineVersion({
      scope: INVOICE,
      viewportId: "tablet",
      versionId: older.version.id,
    });
    expect(again.revision).toBe(restored.revision);

    // And the newer version can be put back.
    const reActivated = await activateBaselineVersion({
      scope: INVOICE,
      viewportId: "tablet",
      versionId: newer.version.id,
    });
    expect(reActivated.activeVersionId).toBe(newer.version.id);
  });

  it("refuses unknown versions and scopes with no history", async () => {
    await expect(
      activateBaselineVersion({
        scope: INVOICE,
        viewportId: "tablet",
        versionId: "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
      }),
    ).rejects.toMatchObject({ code: "baseline_version_unknown", status: 400 });

    await expect(
      activateBaselineVersion({ scope: INVOICE, viewportId: "desktop", versionId: "../../../etc/passwd" }),
    ).rejects.toMatchObject({ code: "baseline_version_unknown" });

    await expect(
      activateBaselineVersion({
        scope: CONTROL,
        viewportId: "desktop",
        versionId: "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
      }),
    ).rejects.toMatchObject({ code: "baseline_not_found", status: 404 });

    // A version that exists for one project route cannot be activated for another.
    const home = await readBaselineManifest(EXAMPLE_HOME, "desktop");
    await expect(
      activateBaselineVersion({
        scope: EXAMPLE_CHECKOUT,
        viewportId: "desktop",
        versionId: home!.versions[0].id,
      }),
    ).rejects.toMatchObject({ code: "baseline_not_found" });
  });
});

describe("manifest integrity", () => {
  it("refuses a manifest whose rows belong to another scope", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "mobile" });
    await approveFromRun(runId, INVOICE, "mobile");

    const manifestPath = manifestPathOf(INVOICE, "mobile");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      versions: Array<{ targetId: string }>;
    };
    manifest.versions[0].targetId = "baseline-control";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(readBaselineManifest(INVOICE, "mobile")).rejects.toMatchObject({
      code: "baseline_unreadable",
      status: 500,
    });
  });

  it("refuses a project manifest that quietly claims to be a demo target", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, scope: EXAMPLE_CHECKOUT, viewportId: "tablet" });
    await approveFromRun(runId, EXAMPLE_CHECKOUT, "tablet");

    const manifestPath = manifestPathOf(EXAMPLE_CHECKOUT, "tablet");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.scope = "demo";
    manifest.projectId = null;
    manifest.routeId = null;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(readBaselineManifest(EXAMPLE_CHECKOUT, "tablet")).rejects.toMatchObject({
      code: "baseline_unreadable",
    });
  });

  it("refuses a manifest that is not JSON", async () => {
    const dir = path.join(DATA_DIR, "baselines", "baseline-control", "desktop");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), "{ this is not json", "utf8");
    await expect(readBaselineManifest(CONTROL, "desktop")).rejects.toMatchObject({
      code: "baseline_unreadable",
    });
  });

  it("reads a Phase 2 manifest that predates scopes, without migrating it", async () => {
    // The exact shape Phase 2 wrote: no `scope`, no project fields.
    const dir = path.join(DATA_DIR, "baselines", "baseline-control", "mobile");
    await mkdir(path.join(dir, "versions"), { recursive: true });
    const legacyId = "bl-11111111-2222-4333-8444-555555555555";
    await writeFile(path.join(dir, "versions", `${legacyId}.png`), solidPng(8, 6, [9, 9, 9]));
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        targetId: "baseline-control",
        targetLabel: "Control · same page twice",
        viewportId: "mobile",
        viewportLabel: "Mobile",
        activeVersionId: legacyId,
        revision: 4,
        updatedAt: new Date().toISOString(),
        versions: [
          {
            id: legacyId,
            targetId: "baseline-control",
            viewportId: "mobile",
            viewportLabel: "Mobile",
            approvedAt: new Date().toISOString(),
            sourceReportId: `run-${randomUUID()}`,
            capturedRoute: "/demo/baseline",
            width: 8,
            height: 6,
            bytes: 100,
            note: null,
            imageUrl: `/api/baselines/baseline-control/mobile/${legacyId}.png`,
          },
        ],
      }),
      "utf8",
    );

    const manifest = await readBaselineManifest(CONTROL, "mobile");
    expect(manifest?.scope).toBe("demo");
    expect(manifest?.activeVersionId).toBe(legacyId);
    const active = await readActiveBaseline(CONTROL, "mobile");
    expect(active?.version.id).toBe(legacyId);

    // Reading it must not have rewritten it: the file still has no `scope` key.
    const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(raw.scope).toBeUndefined();
  });

  it("treats an activeVersionId that points nowhere as unset", async () => {
    const dir = path.join(DATA_DIR, "baselines", "baseline-control", "tablet");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        targetId: "baseline-control",
        targetLabel: "Control · same page twice",
        viewportId: "tablet",
        viewportLabel: "Tablet",
        activeVersionId: "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
        revision: 3,
        updatedAt: new Date().toISOString(),
        versions: [],
      }),
      "utf8",
    );
    const manifest = await readBaselineManifest(CONTROL, "tablet");
    expect(manifest?.activeVersionId).toBeNull();
    expect(await readActiveBaseline(CONTROL, "tablet")).toBeNull();
  });
});

describe("readBaselineImage", () => {
  it("rejects traversal, wrong extensions and unknown versions", async () => {
    for (const file of ["../../etc/passwd", "manifest.json", "bl-nope.png", "report.json"]) {
      await expect(readBaselineImage(INVOICE, "desktop", file)).rejects.toBeInstanceOf(ComparisonError);
    }
    await expect(
      readBaselineImage(INVOICE, "desktop", "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab.png"),
    ).rejects.toMatchObject({ code: "baseline_not_found", status: 404 });
    // A hostile viewport segment is a typed 400, not a raw path error.
    await expect(
      readBaselineImage(INVOICE, "../../etc", "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab.png"),
    ).rejects.toMatchObject({ code: "invalid_viewport", status: 400 });
  });
});
