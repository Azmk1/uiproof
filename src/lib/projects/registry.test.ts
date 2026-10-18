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

describe("parseProjectConfig repair block", () => {
  const executionConfig = (overrides: Record<string, unknown> = {}) => ({
    mode: "container",
    runtime: "auto",
    image: null,
    network: "none",
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    user: null,
    dependenciesVolume: null,
    install: null,
    trustHostExecution: false,
    ...overrides,
  });

  const base = JSON.parse(VALID).projects[0];
  const withRepair = (repair: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      projects: [
        {
          ...base,
          sourceDir: ".",
          ...extra,
          repair,
        },
      ],
    });
  const sandbox = {
    command: ["node", "server.mjs"],
    url: "http://127.0.0.1:4199",
    readyPath: "/healthz",
    env: { NODE_ENV: "test" },
  };

  it("leaves repair null when the project did not register one", () => {
    expect(parseOrThrow(VALID)[0].repair).toBeNull();
    expect(parseOrThrow(VALID)[0].repair).toBeNull();
  });

  it("parses a full repair block", () => {
    const project = parseOrThrow(
      withRepair({
        sandbox,
        build: ["node", "build.mjs"],
        test: ["node", "--test"],
        allow: ["views/**"],
        guardRoutes: ["checkout"],
        entryFiles: ["views/index.html"],
        execution: { mode: "container", image: "node:24-bookworm-slim" },
      }),
    )[0];
    expect(project.repair).toEqual({
      sandbox: { command: ["node", "server.mjs"], url: "http://127.0.0.1:4199", readyPath: "/healthz", env: { NODE_ENV: "test" } },
      build: ["node", "build.mjs"],
      test: ["node", "--test"],
      allow: ["views/**"],
      guardRoutes: ["checkout"],
      entryFiles: ["views/index.html"],
      execution: executionConfig({ image: "node:24-bookworm-slim" }),
    });
  });

  it("defaults to container execution and refuses to guess an image", () => {
    // No execution block at all: the mode is container, which needs an image, and a
    // registration that names neither is refused rather than quietly running on the host.
    expect(parseProjectConfig(withRepair({ sandbox })).error).toMatch(/image is required in container mode/);
  });

  it("parses an explicit container execution block", () => {
    const project = parseOrThrow(
      withRepair({
        sandbox,
        execution: {
          mode: "container",
          runtime: "podman",
          image: "node:24-bookworm-slim",
          network: "egress",
          memoryMb: 1024,
          cpus: 1.5,
          pidsLimit: 128,
          user: "1000:1000",
          dependenciesVolume: "uiproof-app-deps",
          install: ["npm", "ci"],
        },
      }),
    )[0];
    expect(project.repair?.execution).toEqual({
      mode: "container",
      runtime: "podman",
      image: "node:24-bookworm-slim",
      network: "egress",
      memoryMb: 1024,
      cpus: 1.5,
      pidsLimit: 128,
      user: "1000:1000",
      dependenciesVolume: "uiproof-app-deps",
      install: ["npm", "ci"],
      trustHostExecution: false,
    });
  });

  it("requires an explicit trust decision for host execution", () => {
    expect(
      parseProjectConfig(withRepair({ sandbox, execution: { mode: "host" } })).error,
    ).toMatch(/runs generated code with your own privileges/);

    const project = parseOrThrow(
      withRepair({ sandbox, execution: { mode: "host", trustHostExecution: true } }),
    )[0];
    expect(project.repair?.execution.mode).toBe("host");
    expect(project.repair?.execution.trustHostExecution).toBe(true);
  });

  it("refuses an execution block that cannot be honoured", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ sandbox, execution: { mode: "vm" } }, /must be "container" or "host"/],
      [{ sandbox, execution: { mode: "container", image: "node" } }, /explicit tag/],
      [{ sandbox, execution: { mode: "container", image: "node:24", network: "host" } }, /network/],
      [{ sandbox, execution: { mode: "container", image: "node:24", runtime: "containerd" } }, /runtime/],
      [{ sandbox, execution: { mode: "container", image: "node:24", memoryMb: 8 } }, /memoryMb/],
      [{ sandbox, execution: { mode: "container", image: "node:24", cpus: 0 } }, /cpus/],
      [{ sandbox, execution: { mode: "container", image: "node:24", user: "root" } }, /user/],
      [{ sandbox, execution: { mode: "container", image: "node:24", install: ["npm", "ci"] } }, /dependenciesVolume/],
      [{ sandbox, execution: { mode: "host", trustHostExecution: true, image: "node:24" } }, /only used in container mode/],
    ];
    for (const [repair, error] of cases) {
      expect(parseProjectConfig(withRepair(repair)).error, JSON.stringify(repair)).toMatch(error);
    }
  });

  it("refuses a sandbox that is not shell-free, loopback and secret-free", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /sandbox must be an object/],
      [{ sandbox: { ...sandbox, command: [] } }, /non-empty array/],
      [{ sandbox: { ...sandbox, command: ["node", "a; rm -rf /"] } }, /shell metacharacter/],
      [{ sandbox: { ...sandbox, command: ["node", "../outside.mjs"] } }, /parent-directory/],
      [{ sandbox: { ...sandbox, url: "https://example.com" } }, /loopback/],
      [{ sandbox: { ...sandbox, readyPath: "healthz" } }, /readyPath/],
      [{ sandbox: { ...sandbox, env: { UIPROOF_AI_API_KEY: "x" } } }, /credential/],
      [{ sandbox: { ...sandbox, env: { "bad key": "x" } } }, /variable name/],
    ];
    for (const [repair, error] of cases) {
      expect(parseProjectConfig(withRepair(repair)).error, JSON.stringify(repair)).toMatch(error);
    }
  });

  it("refuses guard routes and allow patterns that escape the project", () => {
    expect(parseProjectConfig(withRepair({ sandbox, guardRoutes: ["nope"] })).error).toMatch(/route id/);
    expect(parseProjectConfig(withRepair({ sandbox, allow: ["../src/**"] })).error).toMatch(/may not contain/);
    expect(parseProjectConfig(withRepair({ sandbox, allow: [] })).error).toMatch(/non-empty array/);
    expect(parseProjectConfig(withRepair({ sandbox, entryFiles: ["../secret.html"] })).error).toMatch(/relative POSIX path/);
    expect(parseProjectConfig(withRepair({ sandbox, entryFiles: ["/etc/passwd"] })).error).toMatch(/relative POSIX path/);
    expect(parseProjectConfig(withRepair({ sandbox, build: ["node", "x", "y", "z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q"] })).error).toMatch(/limit is 20/);
  });
});
