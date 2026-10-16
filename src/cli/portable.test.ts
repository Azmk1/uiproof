import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineScopeKey,
  resolveBaselineManifestPath,
  resolveBaselineVersionPath,
} from "@/lib/compare/baseline-paths";
import { importBaselineVersion, readBaselineManifest } from "@/lib/compare/baselines";
import { ComparisonError } from "@/lib/compare/errors";
import { sha256Hex } from "@/lib/compare/integrity";
import {
  BUNDLE_MANIFEST_FILENAME,
  bundleVersionRelativePath,
  exportPortableBaselines,
  importPortableBaselines,
  parsePortableBundle,
  resolveBundlePath,
  scopeOfPortableScope,
} from "./portable";

/**
 * The bundle is the one artifact a developer commits and a clean CI runner trusts, so
 * these tests treat it as hostile input: wrong format, wrong scope, unusable path, wrong
 * bytes, and a version id that already exists on the importing machine with other content.
 *
 * Bundles under test are produced by `exportPortableBaselines` itself — the same code path
 * a developer runs — and then edited by hand, which is exactly what a truncated download or
 * a hand-tweaked manifest looks like.
 */

const VERSION_ID = "bl-11111111-2222-4333-8444-555555555555";
const OTHER_VERSION_ID = "bl-99999999-8888-4777-8666-555555555555";
const APPROVED_AT = "2026-01-02T03:04:05.000Z";
const SOURCE_RUN = "run-11111111-2222-4333-8444-555555555555";
const PROJECT_SCOPE = { kind: "project", projectId: "example-app", routeId: "home" } as const;
const ALL = { projectId: null, routeId: null, viewportId: null, all: false } as const;

const TEMP_DIRS: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `uiproof-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function png(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = rgb[0];
    image.data[index + 1] = rgb[1];
    image.data[index + 2] = rgb[2];
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}

/** Puts one approved version in a store, the way `capture --approve` would. */
async function seedStore(
  store: string,
  options: {
    readonly scope?: typeof PROJECT_SCOPE | { readonly kind: "demo"; readonly targetId: string };
    readonly viewportId?: string;
    readonly versionId?: string;
    readonly png: Buffer;
    readonly activate?: boolean;
  },
): Promise<void> {
  await importBaselineVersion({
    scope: options.scope ?? PROJECT_SCOPE,
    viewportId: options.viewportId ?? "desktop",
    versionId: options.versionId ?? VERSION_ID,
    png: options.png,
    approvedAt: APPROVED_AT,
    sourceReportId: SOURCE_RUN,
    capturedRoute: "/",
    note: "approved by a test",
    routeName: "Overview",
    origin: "http://127.0.0.1:4173",
    activate: options.activate ?? true,
    cwd: store,
  });
}

/** Exports a store into a bundle directory and returns both paths. */
async function makeBundle(
  store: string,
  out: string,
  selection: { projectId?: string | null; routeId?: string | null; viewportId?: string | null; all?: boolean } = ALL,
): Promise<{ readonly root: string; readonly manifest: string }> {
  const result = await exportPortableBaselines({ out, selection, generator: "test", cwd: store });
  return { root: path.resolve(out), manifest: result.manifestPath };
}

type Json = Record<string, unknown>;

function jsonOf(raw: string): Json {
  return JSON.parse(raw) as Json;
}

function scopesOf(bundle: Json): Json[] {
  return bundle.scopes as Json[];
}

function versionsOf(scope: Json): Json[] {
  return scope.versions as Json[];
}

/**
 * Edits a copy of a bundle manifest, writes it back over the real file and returns the
 * edited JSON. Every call starts from the pristine manifest so one edit cannot leak into
 * the next assertion.
 */
async function editManifest(
  manifestPath: string,
  pristine: string,
  edit: (bundle: Json) => void,
): Promise<string> {
  const bundle = jsonOf(pristine);
  edit(bundle);
  await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return JSON.stringify(bundle);
}

describe("bundle paths", () => {
  it("derives the one path a version may live at", () => {
    expect(bundleVersionRelativePath(PROJECT_SCOPE, "desktop", VERSION_ID)).toBe(
      `scopes/projects/example-app/home/desktop/versions/${VERSION_ID}.png`,
    );
    expect(bundleVersionRelativePath({ kind: "demo", targetId: "invoice-summary" }, "mobile", VERSION_ID)).toBe(
      `scopes/demo/invoice-summary/mobile/versions/${VERSION_ID}.png`,
    );
    // A version id is not free text, so a traversal attempt cannot even be spelled.
    expect(() => bundleVersionRelativePath(PROJECT_SCOPE, "desktop", "../../etc/passwd")).toThrow(RangeError);
  });

  it("refuses a bundle path that leaves the bundle", () => {
    const root = path.join(tmpdir(), "uiproof-bundle-root");
    expect(resolveBundlePath(root, `scopes/projects/example-app/home/desktop/versions/${VERSION_ID}.png`, "version")).toBe(
      path.resolve(root, `scopes/projects/example-app/home/desktop/versions/${VERSION_ID}.png`),
    );
    for (const bad of ["../outside.png", "/etc/passwd", "scopes/../../x.png", "scopes\\x.png", ""]) {
      expect(() => resolveBundlePath(root, bad, "version"), bad).toThrow(ComparisonError);
    }
  });
});

describe("parsePortableBundle", () => {
  it("accepts a bundle this build wrote", async () => {
    const store = path.join(await tempDir("store-parse"), "data");
    await seedStore(store, { png: png(8, 8, [10, 20, 30]) });
    const bundle = await makeBundle(store, path.join(await tempDir("bundle-parse"), "bundle"));

    const parsed = parsePortableBundle(await readFile(bundle.manifest, "utf8"));
    expect(parsed.format).toBe("uiproof-baselines");
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.scopes).toHaveLength(1);
    expect(scopeOfPortableScope(parsed.scopes[0])).toEqual(PROJECT_SCOPE);
    expect(parsed.scopes[0].versions[0].sha256).toHaveLength(64);
    expect(parsed.scopes[0].versions[0].file).toBe(
      bundleVersionRelativePath(PROJECT_SCOPE, "desktop", VERSION_ID),
    );
  });

  it("refuses a manifest that is not a bundle, or a scope it cannot load", async () => {
    const store = path.join(await tempDir("store-bad"), "data");
    await seedStore(store, { png: png(8, 8, [10, 20, 30]) });
    const bundle = await makeBundle(store, path.join(await tempDir("bundle-bad"), "bundle"));
    const good = await readFile(bundle.manifest, "utf8");

    /** Edits the manifest, then hands the edited JSON to the parser. */
    const rejected = async (edit: (value: Json) => void, matcher: RegExp): Promise<void> => {
      const edited = await editManifest(bundle.manifest, good, edit);
      expect(() => parsePortableBundle(edited)).toThrow(matcher);
    };

    expect(() => parsePortableBundle("not json")).toThrow(/not valid JSON/);
    expect(() => parsePortableBundle("[]")).toThrow(/must be a JSON object/);
    await rejected((b) => (b.format = "something-else"), /not a uiproof-baselines bundle/);
    await rejected((b) => (b.formatVersion = 99), /Unsupported bundle format version/);
    await rejected((b) => delete b.scopes, /needs a "scopes" array/);
    await rejected((b) => (scopesOf(b)[0].kind = "whatever"), /not a scope this build can load/);
    await rejected((b) => (scopesOf(b)[0].projectId = "../../etc"), /not a scope this build can load/);
    await rejected((b) => (scopesOf(b)[0].viewportId = "watch"), /unknown viewport/);
    await rejected((b) => (scopesOf(b)[0].versions = []), /no versions/);
    await rejected((b) => (versionsOf(scopesOf(b)[0])[0].file = "elsewhere/x.png"), /must live at/);
    await rejected((b) => (versionsOf(scopesOf(b)[0])[0].sha256 = "nope"), /malformed SHA-256/);
    await rejected((b) => (versionsOf(scopesOf(b)[0])[0].width = 0), /unusable "width"/);
    await rejected((b) => (versionsOf(scopesOf(b)[0])[0].id = "bl-not-a-uuid"), /unusable version id/);
    await rejected((b) => versionsOf(scopesOf(b)[0]).push({ ...versionsOf(scopesOf(b)[0])[0] }), /twice/);
    await rejected((b) => (scopesOf(b)[0].activeVersionId = OTHER_VERSION_ID), /active version that is not in its version list/);

    // The untouched manifest still parses: every refusal above came from the edit.
    expect(() => parsePortableBundle(good)).not.toThrow();
  });
});

describe("importPortableBaselines", () => {
  it("installs a version on a machine that has never seen one, and is a no-op afterwards", async () => {
    const sourceStore = path.join(await tempDir("store-source"), "data");
    const image = png(8, 8, [1, 2, 3]);
    await seedStore(sourceStore, { png: image });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-src"), "bundle"));

    // A store directory that does not exist yet — the clean-runner case.
    const freshStore = path.join(await tempDir("store-fresh"), "does-not-exist-yet", "data");
    const first = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: freshStore });
    expect(first.added).toBe(1);
    expect(first.alreadyPresent).toBe(0);
    expect(first.scopes[0].activeVersionId).toBe(VERSION_ID);
    expect(first.scopes[0].activeMismatch).toBe(false);

    const stored = await readFile(resolveBaselineVersionPath(PROJECT_SCOPE, "desktop", VERSION_ID, freshStore));
    expect(sha256Hex(stored)).toBe(sha256Hex(image));
    const manifest = await readBaselineManifest(PROJECT_SCOPE, "desktop", freshStore);
    expect(manifest?.versions).toHaveLength(1);
    expect(manifest?.versions[0].capturedRoute).toBe("/");

    const second = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: freshStore });
    expect(second.added).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect((await readBaselineManifest(PROJECT_SCOPE, "desktop", freshStore))?.versions).toHaveLength(1);
  });

  it("activates a version that is already here when the second import asks for it", async () => {
    const sourceStore = path.join(await tempDir("store-src-reactivate"), "data");
    await seedStore(sourceStore, { png: png(8, 8, [5, 5, 5]) });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-reactivate"), "bundle"));

    const store = path.join(await tempDir("store-reactivate"), "data");
    const first = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: false, cwd: store });
    expect(first.scopes[0].activeVersionId).toBeNull();

    // Importing the same bundle again with activation is how a version that is already on
    // the machine becomes the reference — no second copy of the image, no error.
    const second = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: store });
    expect(second.added).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(second.scopes[0].activeVersionId).toBe(VERSION_ID);
    expect(second.scopes[0].activeMismatch).toBe(false);

    const manifest = await readBaselineManifest(PROJECT_SCOPE, "desktop", store);
    expect(manifest?.activeVersionId).toBe(VERSION_ID);
    expect(manifest?.versions).toHaveLength(1);
    expect(await readFile(resolveBaselineVersionPath(PROJECT_SCOPE, "desktop", VERSION_ID, store))).toEqual(
      png(8, 8, [5, 5, 5]),
    );
  });

  it("stores versions without making them active unless --activate was asked for", async () => {
    const sourceStore = path.join(await tempDir("store-src-inactive"), "data");
    await seedStore(sourceStore, { png: png(8, 8, [9, 9, 9]) });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-inactive"), "bundle"));

    const store = path.join(await tempDir("store-inactive"), "data");
    const result = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: false, cwd: store });
    expect(result.added).toBe(1);
    expect(result.scopes[0].activeVersionId).toBeNull();
    expect(result.scopes[0].activeMismatch).toBe(true);

    const manifest = await readBaselineManifest(PROJECT_SCOPE, "desktop", store);
    expect(manifest?.versions).toHaveLength(1);
    // The version exists, but nothing is approved as the reference yet.
    expect(manifest?.activeVersionId).toBeNull();
  });

  it("refuses an image that does not match its recorded SHA-256, and writes nothing", async () => {
    const sourceStore = path.join(await tempDir("store-src-tampered"), "data");
    await seedStore(sourceStore, { png: png(8, 8, [1, 2, 3]) });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-tampered"), "bundle"));

    // A byte flipped in transit: same length, different content.
    const relative = bundleVersionRelativePath(PROJECT_SCOPE, "desktop", VERSION_ID);
    const file = resolveBundlePath(bundle.root, relative, "version");
    const damaged = Buffer.from(await readFile(file));
    damaged[damaged.byteLength - 1] ^= 0xff;
    await writeFile(file, damaged);

    const store = path.join(await tempDir("store-tampered"), "data");
    await expect(
      importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: store }),
    ).rejects.toThrow(/does not match its recorded SHA-256/);
    expect(await readBaselineManifest(PROJECT_SCOPE, "desktop", store)).toBeNull();
  });

  it("refuses a missing image and a missing bundle", async () => {
    const sourceStore = path.join(await tempDir("store-src-missing"), "data");
    await seedStore(sourceStore, { png: png(8, 8, [1, 2, 3]) });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-missing"), "bundle"));
    await rm(resolveBundlePath(bundle.root, bundleVersionRelativePath(PROJECT_SCOPE, "desktop", VERSION_ID), "version"));

    const store = path.join(await tempDir("store-missing"), "data");
    await expect(importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: store })).rejects.toThrow(
      /bundle is missing/,
    );
    await expect(
      importPortableBaselines({ from: path.join(tmpdir(), "uiproof-no-such-bundle"), selection: ALL, activate: true, cwd: store }),
    ).rejects.toThrow(new RegExp(`No ${BUNDLE_MANIFEST_FILENAME}`));
  });

  it("refuses an id that already exists here with different content, keeping the approved image", async () => {
    const firstSource = path.join(await tempDir("store-src-a"), "data");
    const secondSource = path.join(await tempDir("store-src-b"), "data");
    const original = png(8, 8, [1, 2, 3]);
    await seedStore(firstSource, { png: original });
    await seedStore(secondSource, { png: png(8, 8, [4, 5, 6]) });
    const firstBundle = await makeBundle(firstSource, path.join(await tempDir("bundle-a"), "bundle"));
    const secondBundle = await makeBundle(secondSource, path.join(await tempDir("bundle-b"), "bundle"));

    const store = path.join(await tempDir("store-conflict"), "data");
    await importPortableBaselines({ from: firstBundle.root, selection: ALL, activate: true, cwd: store });

    // The second bundle is internally consistent, so it passes its own integrity check and
    // reaches the store's rule that an approved version is immutable.
    await expect(
      importPortableBaselines({ from: secondBundle.root, selection: ALL, activate: true, cwd: store }),
    ).rejects.toThrow(/with different image content/);

    const stored = await readFile(resolveBaselineVersionPath(PROJECT_SCOPE, "desktop", VERSION_ID, store));
    expect(sha256Hex(stored)).toBe(sha256Hex(original));
  });

  it("refuses a bundle with no scope the caller asked for", async () => {
    const sourceStore = path.join(await tempDir("store-src-filter"), "data");
    await seedStore(sourceStore, { png: png(8, 8, [1, 1, 1]) });
    const bundle = await makeBundle(sourceStore, path.join(await tempDir("bundle-filter"), "bundle"));

    const store = path.join(await tempDir("store-filter"), "data");
    await expect(
      importPortableBaselines({
        from: bundle.root,
        selection: { projectId: "another-app", routeId: null, viewportId: null, all: false },
        activate: true,
        cwd: store,
      }),
    ).rejects.toThrow(/no scope matching/);
  });
});

describe("exportPortableBaselines", () => {
  it("writes a bundle a clean machine can read back", async () => {
    const store = path.join(await tempDir("store-round"), "data");
    const image = png(8, 8, [30, 40, 50]);
    await seedStore(store, { png: image });
    const bundle = await makeBundle(store, path.join(await tempDir("bundle-round"), "bundle"), {
      projectId: "example-app",
      routeId: "home",
    });

    const parsed = parsePortableBundle(await readFile(bundle.manifest, "utf8"));
    const version = parsed.scopes[0].versions[0];
    expect(version.sha256).toBe(sha256Hex(image));
    expect(version.bytes).toBe(image.byteLength);
    expect(version.width).toBe(8);
    expect(version.height).toBe(8);
    expect(parsed.scopes[0].activeVersionId).toBe(VERSION_ID);
    expect(parsed.scopes[0].routeName).toBe("Overview");
    expect(parsed.scopes[0].origin).toBe("http://127.0.0.1:4173");
    // The bundle image is byte-identical to the stored one.
    const bundled = await readFile(resolveBundlePath(bundle.root, version.file, version.id));
    expect(sha256Hex(bundled)).toBe(version.sha256);

    // Exporting again over the same directory refreshes the metadata, not the images.
    await expect(
      exportPortableBaselines({
        out: bundle.root,
        selection: ALL,
        generator: "test",
        cwd: store,
      }),
    ).resolves.toMatchObject({ scopes: 1, versions: 1 });
  });

  it("refuses to rewrite a bundled image that no longer matches the store", async () => {
    const store = path.join(await tempDir("store-guard"), "data");
    await seedStore(store, { png: png(8, 8, [1, 2, 3]) });
    const bundle = await makeBundle(store, path.join(await tempDir("bundle-guard"), "bundle"));

    const file = resolveBundlePath(
      bundle.root,
      bundleVersionRelativePath(PROJECT_SCOPE, "desktop", VERSION_ID),
      "version",
    );
    await writeFile(file, png(8, 8, [9, 9, 9]));

    await expect(
      exportPortableBaselines({ out: bundle.root, selection: ALL, generator: "test", cwd: store }),
    ).rejects.toThrow(/already exists in this bundle with different content/);
  });

  it("refuses to export when nothing is approved, or when the scope does not match", async () => {
    const emptyStore = path.join(await tempDir("store-empty"), "data");
    await expect(
      exportPortableBaselines({ out: path.join(await tempDir("bundle-empty"), "bundle"), selection: ALL, generator: "test", cwd: emptyStore }),
    ).rejects.toThrow(/no approved baselines to export/i);

    const store = path.join(await tempDir("store-nomatch"), "data");
    await seedStore(store, { png: png(8, 8, [1, 1, 1]) });
    await expect(
      exportPortableBaselines({
        out: path.join(await tempDir("bundle-nomatch"), "bundle"),
        selection: { projectId: "example-app", routeId: "settings", viewportId: null, all: false },
        generator: "test",
        cwd: store,
      }),
    ).rejects.toThrow(/No approved baseline matches/);
  });

  it("carries demo fixtures too, and keeps the bundle separate from the store", async () => {
    const store = path.join(await tempDir("store-demo"), "data");
    const demoScope = { kind: "demo", targetId: "invoice-summary" } as const;
    await seedStore(store, { scope: demoScope, viewportId: "mobile", png: png(8, 8, [7, 7, 7]) });

    const bundle = await makeBundle(store, path.join(await tempDir("bundle-demo"), "bundle"), {
      viewportId: "mobile",
    });
    const parsed = parsePortableBundle(await readFile(bundle.manifest, "utf8"));
    expect(parsed.scopes[0].kind).toBe("demo");
    expect(parsed.scopes[0].targetId).toBe("invoice-summary");
    expect(parsed.scopes[0].viewportId).toBe("mobile");
    expect(baselineScopeKey(scopeOfPortableScope(parsed.scopes[0]))).toBe("demo:invoice-summary");

    // Two artifacts, two manifests: the store keeps runtime metadata, the bundle is portable.
    expect(await readFile(resolveBaselineManifestPath(demoScope, "mobile", store), "utf8")).toContain(VERSION_ID);
    expect(bundle.manifest).not.toContain(path.join(store, "baselines"));

    // And the bundle round-trips through a second, empty store.
    const freshStore = path.join(await tempDir("store-demo-fresh"), "data");
    const imported = await importPortableBaselines({ from: bundle.root, selection: ALL, activate: true, cwd: freshStore });
    expect(imported.added).toBe(1);
    expect(imported.scopes[0].activeVersionId).toBe(VERSION_ID);
  });
});
