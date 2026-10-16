import { describe, expect, it } from "vitest";
import {
  buildProjectCaptureUrl,
  findProject,
  findRoute,
  isValidRoutePath,
  parseLoopbackOrigin,
  parseProjectConfig,
  projectScopeKey,
} from "./registry";
import type { RegisteredProject } from "@/lib/compare/types";

const VALID = JSON.stringify({
  projects: [
    {
      id: "example-app",
      name: "Example app",
      origin: "http://127.0.0.1:4173",
      routes: [
        { id: "home", name: "Home", path: "/" },
        { id: "checkout", name: "Checkout", path: "/checkout" },
      ],
    },
  ],
});

function parseOrThrow(raw: string): readonly RegisteredProject[] {
  const parsed = parseProjectConfig(raw);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.projects;
}

describe("parseProjectConfig", () => {
  it("accepts a registration and derives absolute route URLs", () => {
    const projects = parseOrThrow(VALID);
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project.id).toBe("example-app");
    expect(project.origin).toBe("http://127.0.0.1:4173");
    expect(project.routes.map((route) => route.url)).toEqual([
      "http://127.0.0.1:4173/",
      "http://127.0.0.1:4173/checkout",
    ]);
    expect(project.modes).toEqual(["capture", "baseline"]);
    expect(project.defaultMode).toBe("capture");
    expect(project.allowedOrigins).toEqual([]);
  });

  it("treats an empty project list as valid, not as an error", () => {
    expect(parseProjectConfig('{"projects":[]}')).toEqual({ projects: [], error: null });
  });

  it("rejects a file that is not a JSON object with a projects array", () => {
    expect(parseProjectConfig("{").error).toMatch(/not valid JSON/);
    expect(parseProjectConfig("[]").error).toMatch(/JSON object/);
    expect(parseProjectConfig('{"projects":{}}').error).toMatch(/projects/);
  });

  it("rejects a non-loopback origin", () => {
    const raw = VALID.replace("http://127.0.0.1:4173", "https://example.com");
    expect(parseProjectConfig(raw).error).toMatch(/origin/);
    const lan = VALID.replace("http://127.0.0.1:4173", "http://192.168.1.50:4173");
    expect(parseProjectConfig(lan).error).toMatch(/origin/);
    const wildcard = VALID.replace("http://127.0.0.1:4173", "http://0.0.0.0:4173");
    expect(parseProjectConfig(wildcard).error).toMatch(/origin/);
  });

  it("rejects an origin carrying a path, credentials, query or a bad scheme", () => {
    for (const origin of [
      "http://127.0.0.1:4173/app",
      "http://user:pass@127.0.0.1:4173",
      "http://127.0.0.1:4173/?x=1",
      "file:///tmp/app",
      "ftp://127.0.0.1:4173",
    ]) {
      const parsed = parseProjectConfig(VALID.replace("http://127.0.0.1:4173", origin));
      expect(parsed.error, origin).toMatch(/origin/);
      expect(parsed.projects, origin).toEqual([]);
    }
  });

  it("rejects duplicate project ids and duplicate route ids or paths", () => {
    const project = JSON.parse(VALID).projects[0];
    const twice = parseProjectConfig(JSON.stringify({ projects: [project, project] }));
    expect(twice.error).toMatch(/declared twice/);

    const routeTwice = parseProjectConfig(
      JSON.stringify({
        projects: [{ ...project, routes: [project.routes[0], project.routes[0]] }],
      }),
    );
    expect(routeTwice.error).toMatch(/twice/);

    const samePath = parseProjectConfig(
      JSON.stringify({
        projects: [
          {
            ...project,
            routes: [
              { id: "one", name: "One", path: "/same" },
              { id: "two", name: "Two", path: "/same" },
            ],
          },
        ],
      }),
    );
    expect(samePath.error).toMatch(/path "\/same" twice/);
  });

  it("rejects an empty route list, a nameless route and a missing name", () => {
    const project = JSON.parse(VALID).projects[0];
    expect(parseProjectConfig(JSON.stringify({ projects: [{ ...project, routes: [] }] })).error).toMatch(/routes/);
    expect(
      parseProjectConfig(JSON.stringify({ projects: [{ ...project, routes: [{ id: "a", name: "", path: "/" }] }] }))
        .error,
    ).toMatch(/name/);
    expect(parseProjectConfig(JSON.stringify({ projects: [{ ...project, name: "" }] })).error).toMatch(/name/);
  });

  it("keeps allowedOrigins explicit and refuses wildcards or paths", () => {
    const project = JSON.parse(VALID).projects[0];
    const withOne = parseProjectConfig(
      JSON.stringify({ projects: [{ ...project, allowedOrigins: ["https://fonts.example"] }] }),
    );
    expect(withOne.projects[0].allowedOrigins).toEqual(["https://fonts.example"]);

    for (const bad of [["*"], ["https://fonts.example/app"], ["https://user:pw@fonts.example"], ["not a url"], [42]]) {
      const parsed = parseProjectConfig(JSON.stringify({ projects: [{ ...project, allowedOrigins: bad }] }));
      expect(parsed.error, String(bad)).toMatch(/allowed origin/);
    }

    // A trailing slash is the same origin written differently, so it normalises away.
    const normalised = parseProjectConfig(
      JSON.stringify({ projects: [{ ...project, allowedOrigins: ["https://fonts.example/"] }] }),
    );
    expect(normalised.projects[0].allowedOrigins).toEqual(["https://fonts.example"]);
  });

  it("drops the project's own origin from allowedOrigins", () => {
    const project = JSON.parse(VALID).projects[0];
    const parsed = parseProjectConfig(
      JSON.stringify({ projects: [{ ...project, allowedOrigins: ["http://127.0.0.1:4173", "http://localhost:9999"] }] }),
    );
    expect(parsed.projects[0].allowedOrigins).toEqual(["http://localhost:9999"]);
  });
});

describe("isValidRoutePath", () => {
  it("accepts ordinary and nested paths", () => {
    for (const path of ["/", "/checkout", "/settings/profile", "/a_b-c/d.e~f", "/pricing/"]) {
      expect(isValidRoutePath(path), path).toBe(true);
    }
  });

  it("rejects traversal, hosts, queries, fragments and tricks", () => {
    for (const path of [
      "",
      "checkout",
      "//evil.example",
      "/../etc/passwd",
      "/a/../../b",
      "/%2e%2e/secret",
      "/%2f%2fevil.example",
      "/app?x=1",
      "/app#frag",
      "http://127.0.0.1:4173/",
      "/app/../",
      "/with space",
      "/app\\..\\",
      `/app/${"x".repeat(300)}`,
    ]) {
      expect(isValidRoutePath(path), path).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isValidRoutePath(undefined)).toBe(false);
    expect(isValidRoutePath(null)).toBe(false);
    expect(isValidRoutePath(42)).toBe(false);
    expect(isValidRoutePath({ path: "/" })).toBe(false);
  });
});

describe("parseLoopbackOrigin", () => {
  it("normalises the spellings of loopback", () => {
    expect(parseLoopbackOrigin("http://localhost:4173")).toBe("http://localhost:4173");
    expect(parseLoopbackOrigin("  http://127.0.0.1:4173  ")).toBe("http://127.0.0.1:4173");
    expect(parseLoopbackOrigin("http://[::1]:4173")).toBe("http://[::1]:4173");
    expect(parseLoopbackOrigin("https://127.0.0.1:8443")).toBe("https://127.0.0.1:8443");
  });

  it("rejects everything else", () => {
    for (const value of ["", "example.com", "https://example.com", "ws://127.0.0.1:4173", "http://169.254.1.1:4173", 5, null]) {
      expect(parseLoopbackOrigin(value), String(value)).toBeNull();
    }
  });
});

describe("buildProjectCaptureUrl", () => {
  const [project] = parseOrThrow(VALID);

  it("builds the URL for an approved route", () => {
    const route = findRoute(project, "checkout")!;
    expect(buildProjectCaptureUrl(project, route).toString()).toBe("http://127.0.0.1:4173/checkout");
  });

  it("refuses a route object whose path was tampered with after parsing", () => {
    const route = findRoute(project, "home")!;
    expect(() => buildProjectCaptureUrl(project, { ...route, path: "//evil.example" })).toThrow(/unapproved/);
    expect(() => buildProjectCaptureUrl(project, { ...route, path: "https://evil.example/" })).toThrow(/unapproved/);
    expect(() => buildProjectCaptureUrl(project, { ...route, path: "/app?next=//evil" })).toThrow(/unapproved/);
  });

  it("looks projects and routes up by id without wildcards", () => {
    expect(findProject([project], "example-app")?.name).toBe("Example app");
    expect(findProject([project], "Example-App")).toBeUndefined();
    expect(findProject([project], null)).toBeUndefined();
    expect(findRoute(project, "home")?.path).toBe("/");
    expect(findRoute(project, "../home")).toBeUndefined();
  });

  it("keys a scope without letting ids collide", () => {
    expect(projectScopeKey("example-app", "home")).toBe("project:example-app/home");
    expect(projectScopeKey("example-app", "home")).not.toBe(projectScopeKey("example", "app/home"));
  });
});
