import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisteredProject } from "@/lib/compare/types";
import { runRepair } from "@/lib/repair/engine";
import {
  createRepairExecutor,
  executionConfig,
  probeContainerRuntime,
  type RepairExecutor,
} from "@/lib/repair/container";
import { issuesFromQualityReport } from "@/lib/diagnosis/context";
import { runQualityAudit } from "@/lib/quality/audit";
import { startRepairApp, type RepairApp } from "./support/repair-app";
import { offeredIssueKeys, proposalJson, replaceLinePatch, startStubModel } from "./support/stub-model";

/** The fixture registration the isolated repair runs against. */
function projectFor(app: RepairApp, image: string): RegisteredProject {
  return {
    id: "repair-app",
    name: "Repair fixture",
    origin: app.url,
    routes: [
      { id: "support", name: "Support", path: "/", url: `${app.url}/` },
      { id: "manual", name: "Manual", path: "/manual", url: `${app.url}/manual` },
    ],
    modes: ["capture", "baseline"],
    defaultMode: "capture",
    allowedOrigins: [],
    sourceDir: app.dir,
    repair: {
      sandbox: { command: ["node", "server.mjs"], url: "http://127.0.0.1:4199", readyPath: "/healthz", env: {} },
      build: ["node", "scripts/check-build.mjs"],
      test: ["node", "scripts/check-tests.mjs"],
      allow: ["views/**"],
      guardRoutes: ["manual"],
      entryFiles: ["views/index.html"],
      execution: executionConfig({ image, network: "none" }),
    },
  };
}

/**
 * Phase 9: the container execution model, against a real container runtime.
 *
 * Every claim `docs/REPAIR-SECURITY.md` makes is asserted here by asking the container
 * itself: no network interface, a read-only root filesystem, no capabilities, bounded
 * processes, no credentials from the host environment — and, in the same breath, that a
 * loopback application inside that container is still measurable, because UIProof relays
 * its HTTP over the container's stdio.
 *
 * The suite skips itself (loudly) when no runtime answers, so a machine without Docker runs
 * the rest of the suite instead of failing. That skip is a *skipped check*, never a pass:
 * the report says so.
 */

const IMAGE = process.env.UIPROOF_E2E_IMAGE ?? "node:24-bookworm-slim";

const PROBE_SCRIPT = `#!/usr/bin/env node
/**
 * The isolation probe. It runs *inside the sandbox container* and prints one JSON line
 * describing what it can and cannot do there. The test asserts the JSON.
 */
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";

const out = {};

try {
  out.interfaces = Object.entries(os.networkInterfaces())
    .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal))
    .map(([name]) => name);
} catch (error) {
  out.interfacesError = String(error);
}

try {
  await fetch("https://example.com", { signal: AbortSignal.timeout(5000) });
  out.egress = "reached";
} catch (error) {
  out.egress = "blocked:" + (error && error.name ? error.name : "error");
}

try {
  await writeFile("/uiproof-root-write-test", "x");
  out.rootWritable = true;
} catch (error) {
  out.rootWritable = false;
  out.rootError = error.code ?? String(error);
}

try {
  await writeFile("/work/probe-write-test.txt", "written by the probe\\n");
  out.workWritable = true;
} catch (error) {
  out.workError = String(error);
}

try {
  await writeFile("/tmp/probe-write-test.txt", "x");
  out.tmpWritable = true;
} catch {
  out.tmpWritable = false;
}

try {
  const status = await readFile("/proc/self/status", "utf8");
  const line = status.split("\\n").find((entry) => entry.startsWith("CapEff:"));
  out.capabilities = line ? line.split(/\\s+/)[1] : null;
} catch (error) {
  out.capabilitiesError = String(error);
}

try {
  out.secretVisible = typeof process.env.UIPROOF_AI_API_KEY === "string" && process.env.UIPROOF_AI_API_KEY.length > 0;
  out.hostPathVisible = Boolean(process.env.USERPROFILE || process.env.LOCALAPPDATA);
  out.home = process.env.HOME ?? null;
} catch (error) {
  out.envError = String(error);
}

try {
  const maximum = await readFile("/sys/fs/cgroup/memory.max", "utf8");
  out.memoryMax = maximum.trim();
} catch (error) {
  try {
    out.memoryMax = (await readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8")).trim();
  } catch {
    out.memoryMaxError = String(error);
  }
}

// How many children can be started at once: the PIDs limit is what stops a fork bomb.
// The probe prints and exits as soon as the count settles, and a watchdog prints what it
// has after 20 seconds: a runtime that throttles process creation must not turn this into
// a hang.
out.childrenStarted = 0;
function print() {
  process.stdout.write("PROBE " + JSON.stringify(out) + "\\n");
  process.exit(0);
}
const watchdog = setTimeout(print, 20000);
watchdog.unref();

const spawns = [];
for (let index = 0; index < 600; index += 1) {
  spawns.push(new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 2000)"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      out.childrenStarted += 1;
      resolve(true);
    });
  }));
}
await Promise.all(spawns);
clearTimeout(watchdog);
print();
`;

describe("a whole repair, isolated", () => {
  let available = false;
  let skipReason = "";
  let project: RegisteredProject | null = null;
  let app: RepairApp | null = null;
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    const probe = await probeContainerRuntime({ refresh: true });
    available = probe.available;
    if (!probe.available) {
      skipReason = probe.reason;
      return;
    }

    previousDataDir = process.env.UIPROOF_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-container-repair-"));
    process.env.UIPROOF_DATA_DIR = dataDir;

    app = await startRepairApp();
    project = projectFor(app, IMAGE);
  }, 180_000);

  afterAll(async () => {
    await app?.stop().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.UIPROOF_DATA_DIR;
    else process.env.UIPROOF_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("runs audit, proposal, patch, build, test and re-measurement inside the container", async () => {
    if (!available) {
      console.warn(`container repair e2e skipped: ${skipReason}`);
      expect(skipReason.length).toBeGreaterThan(0);
      return;
    }
    const original = await app!.readView();
    const { report } = await runQualityAudit({
      source: { kind: "project", projectId: "repair-app", routeId: "support" },
      viewports: ["mobile"],
      origin: "http://127.0.0.1",
      projects: [project!],
      persist: true,
    });
    const { issues } = issuesFromQualityReport(report);
    const issue = issues.find((entry) => entry.key.startsWith("a11y:label@"));
    expect(issue, issues.map((entry) => entry.key).join(", ")).toBeDefined();

    const patch = replaceLinePatch(
      "views/index.html",
      original,
      '          <input id="email" type="email" autocomplete="email" />',
      ['          <input id="email" type="email" autocomplete="email" />', '          <label for="email">Email</label>'],
    );
    const responding = await startStubModel(({ user }) => {
      const key = offeredIssueKeys(user).find((entry) => entry.startsWith("a11y:label@"));
      if (!key) throw new Error("No label issue was offered");
      return proposalJson({ issueKey: key, patch });
    });

    try {
      const { repair } = await runRepair({
        auditId: report.id,
        maxAttempts: 1,
        lookupProject: () => ({ project: project!, sourceDir: project!.sourceDir ?? null, from: "e2e registration" }),
        env: {
          UIPROOF_AI_API_KEY: "stub-key",
          UIPROOF_AI_BASE_URL: responding.baseUrl,
          UIPROOF_AI_MODEL: "stub-model",
        },
      });

      // The whole pipeline ran, and the record says it ran isolated.
      expect(repair.execution.mode).toBe("container");
      expect(repair.execution.network).toBe("none");
      expect(repair.execution.readOnlyRoot).toBe(true);
      expect(repair.execution.image).toBe(IMAGE);
      expect(repair.status).toBe("verified");
      expect(repair.attempts[0].verification?.build.map((command) => command.status)).toEqual(["passed", "passed"]);

      // Both the target and the guard route were measured, in the container, twice.
      const before = repair.before.pages.map((page) => `${page.routeId}@${page.viewportId}`).sort();
      const after = repair.attempts[0].verification!.after!.pages.map((page) => `${page.routeId}@${page.viewportId}`).sort();
      expect(before).toEqual(["manual@desktop", "support@mobile"]);
      expect(after).toEqual(before);
      expect(repair.attempts[0].verification!.regressions.filter((check) => check.status !== "clear")).toEqual([]);

      // The mount is one-way: the developer's own copy was never written to.
      expect(repair.originalUnchanged).toBe(true);
      expect(await app!.readView()).toBe(original);
    } finally {
      await responding.stop();
    }
  }, 600_000);
});

describe("container execution", () => {
  let available = false;
  let reason = "";
  let runtime = "";
  let workDir = "";
  let sandboxDir = "";
  let helperDir = "";
  let executor: RepairExecutor | null = null;

  beforeAll(async () => {
    const probe = await probeContainerRuntime({ refresh: true });
    available = probe.available;
    if (probe.available) {
      runtime = `${probe.runtime.runtime} ${probe.runtime.serverVersion}`;
    } else {
      reason = probe.reason;
      return;
    }

    workDir = await mkdtemp(path.join(os.tmpdir(), "uiproof-container-e2e-"));
    sandboxDir = path.join(workDir, "copy");
    helperDir = path.join(workDir, "relay");
    await mkdir(sandboxDir, { recursive: true });

    // A tiny application: a server that answers on loopback and one script the "build" and
    // "test" commands run. Both are copied into the sandbox like a developer's source.
    await writeFile(
      path.join(sandboxDir, "server.mjs"),
      [
        'import { createServer } from "node:http";',
        "const port = Number(process.env.PORT ?? 4310);",
        'const server = createServer((request, response) => {',
        '  response.writeHead(200, { "content-type": "text/html" });',
        '  response.end("<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><title>Sandbox probe</title></head><body><h1 id=\\"probe-heading\\">Sandbox probe</h1></body></html>");',
        "});",
        'server.listen(port, process.env.HOST ?? "127.0.0.1", () => process.stdout.write(`probe-app listening on ${port}\\n`));',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(sandboxDir, "isolation-probe.mjs"), PROBE_SCRIPT, "utf8");

    executor = await createRepairExecutor({
      config: executionConfig({ image: IMAGE, network: "none", memoryMb: 512, cpus: 1, pidsLimit: 96 }),
      sandboxDir,
      helperDir,
      runId: "e2e0001",
    });
  }, 180_000);

  afterAll(async () => {
    await executor?.cleanup().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("skips with the reason when no runtime answers", () => {
    if (!available) {
      console.warn(`container execution e2e skipped: ${reason}`);
      expect(reason.length).toBeGreaterThan(0);
      return;
    }
    expect(runtime).toMatch(/docker|podman/);
  });

  it("runs a command in a container with no network, no root write and no capabilities", async () => {
    if (!available) return;
    const result = await executor!.runCommand({
      name: "test",
      command: ["node", "isolation-probe.mjs"],
      timeoutMs: 120_000,
    });

    if (result.status !== "passed") {
      // A host without Docker Desktop's Linux VM cannot always enforce every limit; the
      // failure is reported with the container's own output rather than hidden.
      throw new Error(`The isolation probe failed: ${result.reason ?? ""}\n${result.outputTail}`);
    }

    const line = result.outputTail.split("\n").find((entry) => entry.startsWith("PROBE "));
    expect(line, result.outputTail).toBeDefined();
    const probe = JSON.parse(line!.slice("PROBE ".length)) as Record<string, unknown>;

    // No interface other than loopback, and no way out to the internet.
    expect(probe.interfaces).toEqual([]);
    expect(String(probe.egress)).toMatch(/^blocked/);
    // The root filesystem is read-only; the checkout and /tmp are the only writable paths.
    expect(probe.rootWritable).toBe(false);
    expect(probe.workWritable).toBe(true);
    expect(probe.tmpWritable).toBe(true);
    // Every capability dropped.
    expect(String(probe.capabilities)).toBe("0000000000000000");
    // No credentials, and no host paths.
    expect(probe.secretVisible).toBe(false);
    expect(probe.hostPathVisible).toBe(false);
    expect(probe.home).toBe("/tmp");
    // Resource limits are visible to the container itself.
    expect(String(probe.memoryMax)).toBe(String(512 * 1024 * 1024));
    expect(Number(probe.childrenStarted)).toBeLessThan(600);
  }, 180_000);

  it("does not hand a secret-looking host variable to the container", async () => {
    if (!available) return;
    const previous = process.env.UIPROOF_AI_API_KEY;
    process.env.UIPROOF_AI_API_KEY = "sk-must-not-reach-the-sandbox";
    try {
      const result = await executor!.runCommand({
        name: "build",
        command: ["node", "-e", "console.log('SECRET:' + (process.env.UIPROOF_AI_API_KEY ?? 'absent'))"],
        timeoutMs: 60_000,
      });
      expect(result.status).toBe("passed");
      expect(result.outputTail).toContain("SECRET:absent");
    } finally {
      if (previous === undefined) delete process.env.UIPROOF_AI_API_KEY;
      else process.env.UIPROOF_AI_API_KEY = previous;
    }
  }, 120_000);

  it("measures a loopback application inside a container that has no network", async () => {
    if (!available) return;
    const url = "http://127.0.0.1:4311";
    const server = await executor!.startServer({
      command: ["node", "server.mjs"],
      url,
      readyPath: "/",
      env: { PORT: "4311", HOST: "127.0.0.1" },
    });
    try {
      const response = await fetch(`${url}/`, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sandbox probe");
      // The page came through the relay; the container it came from has no network.
      expect(server.log()).toContain("probe-app listening");
      const second = await fetch(`${url}/`, { redirect: "manual" });
      expect(second.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 180_000);

  it("leaves no container behind when a run finishes", async () => {
    if (!available) return;
    await executor!.cleanup();
    const listed = await new Promise<string>((resolve) => {
      execFile(
        runtime.split(" ")[0],
        ["ps", "--all", "--filter", "label=uiproof.repair", "--format", "{{.Names}}"],
        { timeout: 30_000 },
        (error, stdout) => resolve(error ? "" : String(stdout)),
      );
    });
    expect(listed.trim()).toBe("");
  }, 60_000);
});
