import { describe, expect, it } from "vitest";
import { COMPARISON_TARGETS } from "./targets";
import {
  baselineApiPath,
  defaultSelection,
  demoSelection,
  modeForSource,
  parseSourceId,
  projectSelection,
  resolveSource,
  sourceGroups,
  sourceId,
  sourceRequest,
  sourceScopeKey,
} from "./source-selection";
import type { RegisteredProject } from "./types";

const example: RegisteredProject = {
  id: "example-app",
  name: "Example app",
  origin: "http://127.0.0.1:4173",
  routes: [
    { id: "home", name: "Home", path: "/", url: "http://127.0.0.1:4173/" },
    { id: "settings", name: "Settings", path: "/settings", url: "http://127.0.0.1:4173/settings" },
  ],
  modes: ["capture", "baseline"],
  defaultMode: "capture",
  allowedOrigins: [],
};

const catalog = { targets: COMPARISON_TARGETS, projects: [example] };

describe("source identifiers", () => {
  it("uses the same scope keys the engine and the baseline store use", () => {
    expect(sourceScopeKey(demoSelection("invoice-summary"))).toBe("demo:invoice-summary");
    expect(sourceScopeKey(projectSelection("example-app", "home"))).toBe("project:example-app/home");
    expect(sourceId(projectSelection("example-app", "settings"))).toBe("project:example-app/settings");
  });

  it("round-trips an id back to a selection", () => {
    for (const selection of [demoSelection("invoice-summary"), projectSelection("example-app", "home")]) {
      expect(parseSourceId(sourceId(selection))).toEqual(selection);
    }
  });

  it("refuses anything that is not one of our own ids", () => {
    for (const value of [
      "",
      "invoice-summary",
      "demo:",
      "project:",
      "project:example-app",
      "project:/home",
      "project:example-app/",
      "PROJECT:example-app/home",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(parseSourceId(value), String(value)).toBeNull();
    }
  });
});

describe("sourceRequest", () => {
  it("matches the request shape the API validates", () => {
    expect(sourceRequest(demoSelection("invoice-summary"))).toEqual({ kind: "demo", targetId: "invoice-summary" });
    expect(sourceRequest(projectSelection("example-app", "home"))).toEqual({
      kind: "project",
      projectId: "example-app",
      routeId: "home",
    });
  });
});

describe("resolveSource", () => {
  it("resolves a demo target to its fixture pair", () => {
    const resolved = resolveSource(catalog, demoSelection("invoice-summary"))!;
    expect(resolved.kind).toBe("demo");
    expect(resolved.origin).toBeNull();
    expect(resolved.modes).toContain("fixture");
    expect(resolved.path.startsWith("/demo/")).toBe(true);
    expect(resolved.target?.id).toBe("invoice-summary");
    expect(resolved.project).toBeNull();
  });

  it("resolves a registered route to its project, origin and allowed modes", () => {
    const resolved = resolveSource(catalog, projectSelection("example-app", "settings"))!;
    expect(resolved.kind).toBe("project");
    expect(resolved.label).toBe("Example app · Settings");
    expect(resolved.origin).toBe("http://127.0.0.1:4173");
    expect(resolved.path).toBe("/settings");
    expect(resolved.modes).toEqual(["capture", "baseline"]);
    expect(resolved.defaultMode).toBe("capture");
    expect(resolved.route?.id).toBe("settings");
  });

  it("returns null for a source the catalogue no longer offers", () => {
    expect(resolveSource(catalog, demoSelection("nope"))).toBeNull();
    expect(resolveSource(catalog, projectSelection("nope", "home"))).toBeNull();
    expect(resolveSource(catalog, projectSelection("example-app", "nope"))).toBeNull();
    expect(resolveSource({ targets: [], projects: [] }, demoSelection("invoice-summary"))).toBeNull();
  });
});

describe("defaultSelection", () => {
  it("keeps the Phase 1 default: the first demo fixture", () => {
    expect(defaultSelection(catalog)).toEqual(demoSelection("invoice-summary"));
  });

  it("falls back to a registered route when no demo target exists", () => {
    expect(defaultSelection({ targets: [], projects: [example] })).toEqual(projectSelection("example-app", "home"));
  });

  it("selects nothing when the catalogue is empty", () => {
    expect(defaultSelection({ targets: [], projects: [] })).toBeNull();
  });
});

describe("sourceGroups", () => {
  it("groups demo fixtures and each registered project, naming the origin", () => {
    const groups = sourceGroups(catalog);
    expect(groups.map((group) => group.key)).toEqual(["demo", "project:example-app/home"]);
    expect(groups[0].options.map((option) => option.id)).toEqual(
      COMPARISON_TARGETS.map((target) => `demo:${target.id}`),
    );
    expect(groups[1].label).toBe("Example app");
    expect(groups[1].note).toContain("http://127.0.0.1:4173");
    expect(groups[1].options.map((option) => option.hint)).toEqual(["/", "/settings"]);
  });

  it("still renders the demo group when nothing is registered", () => {
    const groups = sourceGroups({ targets: COMPARISON_TARGETS, projects: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("demo");
  });
});

describe("baselineApiPath", () => {
  it("keeps demo baselines on their Phase 2 path and namespaces projects", () => {
    expect(baselineApiPath(demoSelection("invoice-summary"), "desktop")).toBe(
      "/api/baselines/invoice-summary/desktop",
    );
    expect(baselineApiPath(projectSelection("example-app", "home"), "mobile")).toBe(
      "/api/baselines/projects/example-app/home/mobile",
    );
  });
});

describe("modeForSource", () => {
  it("keeps the current mode when the new source supports it", () => {
    const demo = resolveSource(catalog, demoSelection("invoice-summary"))!;
    expect(modeForSource(demo, "baseline")).toBe("baseline");
  });

  it("falls back to the source's default when it does not", () => {
    const project = resolveSource(catalog, projectSelection("example-app", "home"))!;
    expect(modeForSource(project, "fixture")).toBe("capture");
  });
});
