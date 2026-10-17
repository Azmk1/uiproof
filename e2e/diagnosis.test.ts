import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./support/cli";
import { readE2eRuntime } from "./support/e2e-server";
import { startExampleApp, writeProjectConfig, type ExampleApp } from "./support/example-app";

/**
 * Phase 7, end to end: a real audit of the example application, then `uiproof diagnose`
 * against that stored audit, with the model served by a local OpenAI-compatible stub.
 *
 * The stub is deliberately a *careful* model: it reads the prompt, answers only the issue
 * keys UIProof sent, and cites the excerpt line UIProof showed it. That makes the whole
 * pipeline real — Chromium, axe-core, the stored report, the registered source directory,
 * candidate selection, prompt assembly, validation, citation verification, persistence —
 * while keeping the one non-deterministic component (someone else's model) fixed. A genuine
 * live-model run needs credentials and is reported separately in the delivery notes.
 *
 * The defects are the independent pilot's: a missing accessible name, a contrast failure
 * and a fixed-width banner that escapes a phone viewport, rendered by swapping the example
 * application's own support view for its broken twin.
 */

const PROJECT_ID = "example-app";
const ROUTE_ID = "support";
const SCOPE_KEY = `project:${PROJECT_ID}/${ROUTE_ID}`;

interface MeasuredFact {
  label: string;
  value: string;
}

interface DiagnosedIssue {
  key: string;
  kind: string;
  title: string;
  measured: MeasuredFact[];
  diagnosis: {
    summary: string;
    likelyCause: string;
    repairApproach: string;
    citedFacts: string[];
    confidence: string;
    uncertainty: string | null;
    sources: Array<{ path: string; line: number | null; why: string; lineText: string | null }>;
    unverifiedSources: Array<{ path: string; line: number | null; reason: string }>;
  } | null;
}

interface Diagnosis {
  id: string;
  reportId: string | null;
  auditId: string | null;
  scopeKey: string;
  sourceRoot: string;
  filesScanned: number;
  filesRead: string[];
  model: {
    provider: string;
    model: string;
    endpointHost: string;
    latencyMs: number;
    promptChars: number;
    jsonModeFallback: boolean;
  };
  issues: DiagnosedIssue[];
  warnings: string[];
  aiGenerated: boolean;
}

interface StubModel {
  readonly url: string;
  readonly prompts: string[];
  readonly close: () => Promise<void>;
}

/** The first excerpt UIProof sent for an issue, and its first matched line. */
interface PromptIssue {
  key: string;
  path: string | null;
  line: number | null;
}

function parsePromptIssues(user: string): PromptIssue[] {
  return user
    .split("\n- issue key: ")
    .slice(1)
    .map((block) => {
      const [keyLine, ...rest] = block.split("\n");
      const body = rest.join("\n");
      const file = body.match(/file: (.+?) \(excerpt: lines (\d+)/);
      const matched = body.match(/matched line\(s\): ([\d, ]+)/);
      if (!file) return { key: keyLine.trim(), path: null, line: null };
      const line = matched ? Number(matched[1].split(",")[0].trim()) : Number(file[2]);
      return { key: keyLine.trim(), path: file[1], line };
    });
}

async function startStubModel(): Promise<StubModel> {
  const prompts: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const user = body.messages.find((message) => message.role === "user")?.content ?? "";
      prompts.push(user);

      const issues = parsePromptIssues(user).map((issue) => ({
        key: issue.key,
        summary: "A visitor meets a control or layout the page measures as broken.",
        likelyCause: "The support view changed without the label, tokens or width the page relies on.",
        repairApproach: "Restore the accessible name, the contrast-safe colour or the fluid width, then re-run the audit.",
        citedFacts: ["the measured facts above"],
        confidence: issue.path ? "medium" : "low",
        uncertainty: issue.path ? null : "No source file in the registered directory matched this issue.",
        sources: issue.path
          ? [{ path: issue.path, line: issue.line, why: "The excerpt line that carries this measurement." }]
          : [],
      }));

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: "assistant", content: JSON.stringify({ issues }) } }],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("uiproof diagnose", () => {
  let app: ExampleApp;
  let model: StubModel;
  let scratch = "";
  let configPath = "";
  let storeDir = "";
  let auditId = "";

  const cliEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    UIPROOF_PROJECTS_FILE: configPath,
    UIPROOF_DATA_DIR: storeDir,
    ...extra,
  });

  const modelEnv = (): Record<string, string> => ({
    UIPROOF_AI_API_KEY: "sk-stub-not-a-real-key",
    UIPROOF_AI_BASE_URL: `${model.url}/v1`,
    UIPROOF_AI_MODEL: "stub-diagnostician",
  });

  beforeAll(async () => {
    app = await startExampleApp({ portCandidates: [5331, 5332, 5333, 5334] });
    model = await startStubModel();
    scratch = path.join(os.tmpdir(), `uiproof-diagnosis-${randomUUID()}`);
    storeDir = path.join(scratch, "data");
    configPath = path.join(scratch, "uiproof.config.json");

    // The registration names the application directory explicitly: the browser API never
    // accepts a path, and the CLI reads the one the developer registered.
    await writeProjectConfig(configPath, [
      {
        id: PROJECT_ID,
        name: "Example app",
        origin: app.url,
        sourceDir: app.dir,
        routes: [{ id: ROUTE_ID, name: "Contact support", path: "/support" }],
      },
    ]);

    await app.applyQualityDefects();
    const audit = await runCli(["audit", "--project", PROJECT_ID, "--route", ROUTE_ID, "--config", configPath, "--json"], {
      env: cliEnv(),
    });
    expect(audit.code).toBe(1);
    auditId = (audit.json?.report as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await app?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function diagnose(args: readonly string[], extraEnv: Record<string, string> = modelEnv()) {
    return runCli(["diagnose", ...args, "--json"], { env: cliEnv(extraEnv) });
  }

  function diagnosisOf(run: Awaited<ReturnType<typeof diagnose>>): Diagnosis {
    return (run.json?.diagnosis ?? null) as unknown as Diagnosis;
  }

  it("explains a real failing audit, citing lines UIProof read from the registered source", async () => {
    const run = await diagnose(["--audit", auditId]);
    expect(run.code).toBe(0);
    expect(run.json?.status).toBe("diagnosed");

    const diagnosis = diagnosisOf(run);
    expect(diagnosis.aiGenerated).toBe(true);
    expect(diagnosis.auditId).toBe(auditId);
    expect(diagnosis.reportId).toBeNull();
    expect(diagnosis.scopeKey).toBe(SCOPE_KEY);
    expect(diagnosis.sourceRoot).toBe(app.dir);
    expect(diagnosis.model.model).toBe("stub-diagnostician");
    expect(diagnosis.model.endpointHost).toBe(new URL(model.url).host);
    expect(diagnosis.filesScanned).toBeGreaterThan(0);
    expect(diagnosis.issues.length).toBeGreaterThanOrEqual(3);

    // The measured side is the audit's own numbers, unchanged.
    const missingName = diagnosis.issues.find((issue) =>
      issue.measured.some((fact) => fact.label === "Selector" && fact.value.includes("#support-email")),
    );
    expect(missingName).toBeDefined();
    expect(missingName?.measured.some((fact) => fact.label === "Rule" && fact.value === "label")).toBe(true);
    expect(missingName?.measured.some((fact) => fact.label === "Measured at viewport(s)")).toBe(true);

    // The model's answer is attached, and the citation was verified against the file.
    expect(missingName?.diagnosis?.confidence).toBe("medium");
    expect(missingName?.diagnosis?.unverifiedSources).toEqual([]);
    const cited = missingName?.diagnosis?.sources[0];
    // Both the clean view and its defective twin carry the input; either is a real answer.
    expect(cited?.path).toMatch(/^views\/quality(\.changed)?\.html$/);
    expect(cited?.lineText).toContain("support-email");

    const sourceLines = (await readFile(path.join(app.dir, cited?.path ?? ""), "utf8")).split("\n");
    expect(sourceLines[(cited?.line ?? 0) - 1]).toContain("support-email");

    // The prompt carried the measured facts and the excerpt the citation came from.
    expect(model.prompts.some((prompt) => prompt.includes("views/quality.html"))).toBe(true);
    expect(model.prompts.some((prompt) => prompt.includes("Rule: label"))).toBe(true);

    // The audit's verdict has not moved: a diagnosis is not a gate.
    const stored = JSON.parse(await readFile(path.join(storeDir, "audits", auditId, "audit.json"), "utf8")) as {
      verdict: { status: string };
      viewports: Array<{ accessibility: { findings: unknown[] } }>;
    };
    expect(stored.verdict.status).toBe("fail");
  }, 120_000);

  it("stores the diagnosis in its own directory, separable from reports and audits", async () => {
    const run = await diagnose(["--audit", auditId]);
    const diagnosis = diagnosisOf(run);

    const storedPath = run.json?.path as string;
    expect(storedPath).toBe(path.join(storeDir, "diagnoses", diagnosis.id, "diagnosis.json"));
    const stored = JSON.parse(await readFile(storedPath, "utf8")) as Diagnosis;
    expect(stored.aiGenerated).toBe(true);
    expect(stored.issues.map((issue) => issue.key)).toEqual(diagnosis.issues.map((issue) => issue.key));
    expect(JSON.stringify(stored)).not.toContain("sk-stub-not-a-real-key");
  }, 120_000);

  it("is optional: without a key it exits 2, explains how to enable it, and stores nothing", async () => {
    const before = await diagnoseStoreEntries();
    const run = await diagnose(["--audit", auditId], {});

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("UIPROOF_AI_API_KEY");
    expect(run.json?.exitCode).toBe(2);
    expect(await diagnoseStoreEntries()).toEqual(before);
  }, 120_000);

  it("requires exactly one stored report", async () => {
    const neither = await diagnose([]);
    expect(neither.code).toBe(2);
    expect(neither.stderr).toContain("--report");

    const both = await diagnose(["--audit", auditId, "--report", "run-11111111-2222-4333-8444-555555555555"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("not both");
  }, 120_000);

  it("refuses a source directory that is not there, before contacting the model", async () => {
    const promptsBefore = model.prompts.length;
    const run = await diagnose(["--audit", auditId, "--source", path.join(scratch, "no-such-directory")]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("could not be read");
    expect((run.json?.error as { code: string }).code).toBe("diagnosis_source_invalid");
    expect(model.prompts).toHaveLength(promptsBefore);
  }, 120_000);

  async function diagnoseStoreEntries(): Promise<string[]> {
    try {
      return (await readdir(path.join(storeDir, "diagnoses"))).sort();
    } catch {
      return [];
    }
  }
});

/**
 * The dashboard's side of the feature: the two endpoints its panel calls, driven over HTTP
 * against the suite's production server. Nothing here needs a model — the refusal paths are
 * exactly what a machine without credentials sees, and they must be explicit rather than
 * a disabled button with no explanation.
 */
describe("diagnosis API", () => {
  const base = readE2eRuntime().url;

  async function api(pathname: string, init?: RequestInit) {
    const response = await fetch(`${base}${pathname}`, { cache: "no-store", ...init });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { response, body, text };
  }

  function localPost(payload: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(payload),
    };
  }

  it("reports whether a model is configured, without disclosing anything about a key", async () => {
    const { response, body, text } = await api("/api/diagnoses");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const availability = body?.availability as { configured: boolean; model: string | null; sourceRegistration: string };
    expect(typeof availability.configured).toBe("boolean");
    expect(["config", "missing"]).toContain(availability.sourceRegistration);
    expect(Array.isArray(body?.diagnoses)).toBe(true);

    const key = process.env.UIPROOF_AI_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) expect(availability.configured).toBe(false);
    if (key) expect(text).not.toContain(key);
  });

  it("refuses a diagnosis that does not name exactly one stored report", async () => {
    const neither = await api("/api/diagnoses", localPost({}));
    expect(neither.response.status).toBe(400);
    expect((neither.body?.error as { code: string }).code).toBe("invalid_options");

    const both = await api("/api/diagnoses", localPost({ reportId: "run-1", auditId: "audit-1" }));
    expect(both.response.status).toBe(400);
    expect((both.body?.error as { code: string }).code).toBe("invalid_options");
  });

  it("refuses a cross-site request before spending the model's quota", async () => {
    const { response } = await api("/api/diagnoses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.test", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ auditId: "audit-00000000-0000-4000-8000-000000000000" }),
    });
    expect(response.status).toBe(403);
  });

  it("answers 404 for a report and for a diagnosis that do not exist", async () => {
    const missingReport = await api(
      "/api/diagnoses",
      localPost({ auditId: "audit-00000000-0000-4000-8000-000000000000" }),
    );
    expect(missingReport.response.status).toBe(404);
    expect((missingReport.body?.error as { code: string }).code).toBe("report_not_found");

    const missingDiagnosis = await api("/api/diagnoses/diag-00000000-0000-4000-8000-000000000000");
    expect(missingDiagnosis.response.status).toBe(404);
    expect(missingDiagnosis.body?.error).toMatchObject({ code: "report_not_found" });
  });
});
