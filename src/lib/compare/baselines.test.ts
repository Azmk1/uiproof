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
import type { ComparisonReport } from "./types";

/**
 * The store is exercised against a real temporary data directory: real PNG bytes on
 * disk, real manifest rewrites, real concurrent approvals. Nothing here is stubbed.
 */

const DATA_DIR = path.join(os.tmpdir(), `uiproof-baselines-${randomUUID()}`);

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

function reportFor(input: {
  id: string;
  targetId: string;
  targetLabel: string;
  viewportId: string;
  viewportLabel: string;
  currentPath: string;
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
    target: {
      id: input.targetId,
      label: input.targetLabel,
      baselinePath: "/demo/baseline",
      currentPath: input.currentPath,
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
    engine: { provider: "playwright", comparator: "pixelmatch", browser: "chromium", captureMs: 1, compareMs: 1, totalMs: 2 },
  };
}

/** Writes a run directory the way the engine does, so approvals read real stored data. */
async function seedRun(input: {
  id: string;
  targetId?: string;
  targetLabel?: string;
  viewportId?: string;
  viewportLabel?: string;
  currentPath?: string;
  png?: Buffer;
}): Promise<{ report: ComparisonReport; png: Buffer }> {
  const report = reportFor({
    id: input.id,
    targetId: input.targetId ?? "invoice-summary",
    targetLabel: input.targetLabel ?? "Invoice summary card",
    viewportId: input.viewportId ?? "desktop",
    viewportLabel: input.viewportLabel ?? "Desktop",
    currentPath: input.currentPath ?? "/demo/current",
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

async function versionFiles(targetId = "invoice-summary", viewportId = "desktop"): Promise<string[]> {
  const dir = path.join(DATA_DIR, "baselines", targetId, viewportId, "versions");
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function approveFromRun(runId: string, targetId = "invoice-summary", viewportId = "desktop") {
  return approveBaseline({ targetId, viewportId, sourceReportId: runId });
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
    expect(await readBaselineManifest("invoice-summary", "tablet")).toBeNull();
    expect(await readActiveBaseline("invoice-summary", "tablet")).toBeNull();
  });

  it("adopts a stored run's current.png as the first approved version", async () => {
    const runId = `run-${randomUUID()}`;
    const { png } = await seedRun({ id: runId, viewportId: "desktop" });

    const { manifest, version } = await approveFromRun(runId);

    expect(manifest.activeVersionId).toBe(version.id);
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.revision).toBe(1);
    expect(version).toMatchObject({
      targetId: "invoice-summary",
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
    const stored = await readBaselineImage("invoice-summary", "desktop", `${version.id}.png`);
    expect(Buffer.compare(stored, png)).toBe(0);
    expect(await versionFiles()).toEqual([`${version.id}.png`]);
  });

  it("records the page state that was approved, including its query", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "tablet", currentPath: "/demo/current?variant=original" });
    const { version } = await approveFromRun(runId, "invoice-summary", "tablet");
    expect(version.capturedRoute).toBe("/demo/current?variant=original");
  });

  it("appends a new version instead of overwriting the approved one", async () => {
    const first = `run-${randomUUID()}`;
    const second = `run-${randomUUID()}`;
    await seedRun({ id: first, viewportId: "mobile", png: solidPng(8, 6, [10, 10, 200]) });
    await seedRun({ id: second, viewportId: "mobile", png: solidPng(8, 6, [10, 200, 10]) });

    const firstApproval = await approveFromRun(first, "invoice-summary", "mobile");
    const firstBytes = await readBaselineImage("invoice-summary", "mobile", `${firstApproval.version.id}.png`);

    const secondApproval = await approveFromRun(second, "invoice-summary", "mobile");
    const manifest = await readBaselineManifest("invoice-summary", "mobile");

    expect(manifest?.versions).toHaveLength(2);
    expect(manifest?.activeVersionId).toBe(secondApproval.version.id);
    expect(manifest?.revision).toBe(2);
    expect(await versionFiles("invoice-summary", "mobile")).toHaveLength(2);

    // The older image is untouched: an approval never rewrites history.
    const stillThere = await readBaselineImage("invoice-summary", "mobile", `${firstApproval.version.id}.png`);
    expect(Buffer.compare(stillThere, firstBytes)).toBe(0);
    expect(firstApproval.version.id).not.toBe(secondApproval.version.id);
  });

  it("refuses a run that belongs to another target or viewport", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "desktop" });

    await expect(approveFromRun(runId, "invoice-summary", "mobile")).rejects.toMatchObject({
      code: "baseline_source_mismatch",
      status: 400,
    });
    await expect(approveFromRun(runId, "baseline-control", "desktop")).rejects.toMatchObject({
      code: "baseline_source_mismatch",
    });
    expect(await readBaselineManifest("baseline-control", "desktop")).toBeNull();
  });

  it("refuses unknown targets, viewports and missing runs", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId });

    await expect(approveFromRun(runId, "../../etc", "desktop")).rejects.toMatchObject({ code: "invalid_target" });
    await expect(approveFromRun(runId, "invoice-summary", "watch")).rejects.toMatchObject({
      code: "invalid_viewport",
    });
    await expect(approveBaseline({ targetId: "invoice-summary", viewportId: "desktop", sourceReportId: `run-${randomUUID()}` })).rejects.toMatchObject(
      { code: "report_not_found", status: 404 },
    );
    await expect(
      approveBaseline({ targetId: "invoice-summary", viewportId: "desktop", sourceReportId: "../etc/passwd" }),
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
      targetId: "invoice-summary",
      viewportId: "tablet",
      sourceReportId: runId,
      note: "  after the price fix  ",
    });
    expect(withNote.version.note).toBe("after the price fix");
    await expect(
      approveBaseline({ targetId: "invoice-summary", viewportId: "tablet", sourceReportId: runId, note: "x".repeat(201) }),
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

    const before = (await readBaselineManifest("invoice-summary", "desktop"))?.versions.length ?? 0;
    const approvals = await Promise.all(runs.map((runId) => approveFromRun(runId)));
    const manifest = await readBaselineManifest("invoice-summary", "desktop");
    const approvedIds = approvals.map((approval) => approval.version.id);

    // Five simultaneous approvals must add five versions — not fewer, and not more.
    expect(manifest?.versions).toHaveLength(before + approvedIds.length);
    // Every row is a distinct version, and every approval produced a distinct id.
    expect(new Set(manifest!.versions.map((version) => version.id)).size).toBe(manifest!.versions.length);
    expect(new Set(approvedIds).size).toBe(approvedIds.length);
    expect(manifest?.revision).toBeGreaterThanOrEqual(before + approvedIds.length);
    expect(manifest?.activeVersionId).not.toBeNull();
    expect(approvedIds).toContain(manifest?.activeVersionId);

    // Every manifest row has its image on disk, and no orphan files were left behind.
    const files = await versionFiles();
    expect(files.sort()).toEqual(manifest!.versions.map((version) => `${version.id}.png`).sort());
  });
});

describe("activateBaselineVersion", () => {
  it("restores an earlier version without touching any image", async () => {
    const first = `run-${randomUUID()}`;
    const second = `run-${randomUUID()}`;
    await seedRun({ id: first, viewportId: "tablet", png: solidPng(8, 6, [1, 2, 3]) });
    await seedRun({ id: second, viewportId: "tablet", png: solidPng(8, 6, [4, 5, 6]) });
    const historyBefore = (await readBaselineManifest("invoice-summary", "tablet"))?.versions.length ?? 0;
    const older = await approveFromRun(first, "invoice-summary", "tablet");
    const newer = await approveFromRun(second, "invoice-summary", "tablet");
    const filesBefore = await versionFiles("invoice-summary", "tablet");

    const restored = await activateBaselineVersion({
      targetId: "invoice-summary",
      viewportId: "tablet",
      versionId: older.version.id,
    });

    expect(restored.activeVersionId).toBe(older.version.id);
    // Rolling back the active pointer adds no versions and deletes no image.
    expect(restored.versions).toHaveLength(historyBefore + 2);
    expect(restored.revision).toBeGreaterThanOrEqual(3);
    expect(await versionFiles("invoice-summary", "tablet")).toEqual(filesBefore);

    const active = await readActiveBaseline("invoice-summary", "tablet");
    expect(active?.version.id).toBe(older.version.id);
    expect(Buffer.compare(active!.png, await readBaselineImage("invoice-summary", "tablet", `${older.version.id}.png`))).toBe(0);

    // Idempotent: re-activating the active version is not a new revision.
    const again = await activateBaselineVersion({
      targetId: "invoice-summary",
      viewportId: "tablet",
      versionId: older.version.id,
    });
    expect(again.revision).toBe(restored.revision);

    // And the newer version can be put back.
    const reActivated = await activateBaselineVersion({
      targetId: "invoice-summary",
      viewportId: "tablet",
      versionId: newer.version.id,
    });
    expect(reActivated.activeVersionId).toBe(newer.version.id);
  });

  it("refuses unknown versions and pairs with no history", async () => {
    await expect(
      activateBaselineVersion({
        targetId: "invoice-summary",
        viewportId: "tablet",
        versionId: "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
      }),
    ).rejects.toMatchObject({ code: "baseline_version_unknown", status: 400 });

    await expect(
      activateBaselineVersion({ targetId: "invoice-summary", viewportId: "desktop", versionId: "../../../etc/passwd" }),
    ).rejects.toMatchObject({ code: "baseline_version_unknown" });

    await expect(
      activateBaselineVersion({
        targetId: "baseline-control",
        viewportId: "desktop",
        versionId: "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab",
      }),
    ).rejects.toMatchObject({ code: "baseline_not_found", status: 404 });
  });
});

describe("manifest integrity", () => {
  it("refuses a manifest whose rows belong to another pair", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun({ id: runId, viewportId: "mobile" });
    await approveFromRun(runId, "invoice-summary", "mobile");

    const manifestPath = path.join(DATA_DIR, "baselines", "invoice-summary", "mobile", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      versions: Array<{ targetId: string }>;
    };
    manifest.versions[0].targetId = "baseline-control";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(readBaselineManifest("invoice-summary", "mobile")).rejects.toMatchObject({
      code: "baseline_unreadable",
      status: 500,
    });
  });

  it("refuses a manifest that is not JSON", async () => {
    const dir = path.join(DATA_DIR, "baselines", "baseline-control", "desktop");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), "{ this is not json", "utf8");
    await expect(readBaselineManifest("baseline-control", "desktop")).rejects.toMatchObject({
      code: "baseline_unreadable",
    });
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
    const manifest = await readBaselineManifest("baseline-control", "tablet");
    expect(manifest?.activeVersionId).toBeNull();
    expect(await readActiveBaseline("baseline-control", "tablet")).toBeNull();
  });
});

describe("readBaselineImage", () => {
  it("rejects traversal, wrong extensions and unknown versions", async () => {
    for (const file of ["../../etc/passwd", "manifest.json", "bl-nope.png", "report.json"]) {
      await expect(readBaselineImage("invoice-summary", "desktop", file)).rejects.toBeInstanceOf(ComparisonError);
    }
    await expect(
      readBaselineImage("invoice-summary", "desktop", "bl-8f0c1d2e-3a4b-4c5d-8e9f-0123456789ab.png"),
    ).rejects.toMatchObject({ code: "baseline_not_found", status: 404 });
  });
});
