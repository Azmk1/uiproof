import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import { persistRun } from "@/lib/compare/storage";
import { persistAudit } from "@/lib/quality/storage";
import { runDiagnosis, type DiagnoseInput } from "./diagnose";
import { auditReport, comparisonReport } from "./test-fixtures";
import { makeTree, removeTree } from "./test-temp";

/**
 * The pipeline is exercised end to end against the real report and audit stores and a real
 * temporary source tree. Only the network is faked: the stub model answers with a fixture,
 * which is exactly how a deterministic test can still cover prompt assembly, schema
 * validation, citation verification and persistence.
 *
 * The properties asserted here are the ones the phase promises: measurements survive
 * unchanged, a cited line is the line UIProof read, a missing or broken model changes no
 * verdict and writes nothing, and pointing the tool at a report that passed produces no
 * story at all.
 */

const SETTINGS_FORM = `export function SettingsForm() {
  return (
    <form className="settings-form">
      <label htmlFor="booking-window">Booking window</label>
      <select
        id="booking-status"
        name="status"
        className="input"
      >
        <option value="all">All statuses</option>
      </select>
      <button type="submit">Save</button>
    </form>
  );
}
`;

const A11Y_KEY = "a11y:select-name@#booking-status";
const FORM_PATH = "src/components/settings-form.tsx";

const CLEAN_ENV = { UIPROOF_AI_API_KEY: "sk-test-not-a-real-key", UIPROOF_AI_MODEL: "gpt-4o-mini" } as const;

let dataDir: string;
let sourceRoot: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.UIPROOF_DATA_DIR;
  dataDir = await makeTree({ ".keep": "" });
  process.env.UIPROOF_DATA_DIR = dataDir;
  sourceRoot = await makeTree({
    "src/app/settings/page.tsx": `import { SettingsForm } from "../../components/settings-form";\nexport default function Page() {\n  return <SettingsForm />;\n}\n`,
    [FORM_PATH]: SETTINGS_FORM,
  });
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.UIPROOF_DATA_DIR;
  else process.env.UIPROOF_DATA_DIR = previousDataDir;
  await Promise.all([removeTree(dataDir), removeTree(sourceRoot)]);
});

function bookingStatusLine(): number {
  return SETTINGS_FORM.split("\n").findIndex((line) => line.includes('id="booking-status"')) + 1;
}

interface Stub {
  readonly fetchImpl: typeof fetch;
  readonly calls: Array<Record<string, unknown>>;
}

function modelAnswer(content: string): Stub {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function failingModel(status: number): Stub {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("upstream is having a bad day", { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function promptsOf(stub: Stub): { system: string; user: string } {
  const messages = (stub.calls[0]?.messages ?? []) as Array<{ role: string; content: string }>;
  return {
    system: messages.find((message) => message.role === "system")?.content ?? "",
    user: messages.find((message) => message.role === "user")?.content ?? "",
  };
}

function diagnosisContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issues: [
      {
        key: A11Y_KEY,
        summary: "A screen-reader user reaches a status filter that announces no name.",
        likelyCause: "The select's label was replaced by a visual heading, so no name is associated with it.",
        repairApproach: "Wrap the select in a <label>, or add aria-label=\"Booking status\". Re-run the audit afterwards.",
        citedFacts: ["Rule: select-name", "Selector: #booking-status"],
        confidence: "medium",
        uncertainty: "The excerpt does not show whether a parent element provides a name.",
        sources: [{ path: FORM_PATH, line: bookingStatusLine(), why: "The select axe reported." }],
        ...overrides,
      },
    ],
  });
}

async function storeAudit(): Promise<string> {
  const report = auditReport();
  await persistAudit(report, {
    desktop: Buffer.from("png"),
    tablet: Buffer.from("png"),
    mobile: Buffer.from("png"),
  });
  return report.id;
}

async function storeRun(overrides: Parameters<typeof comparisonReport>[0] = {}): Promise<string> {
  const report = comparisonReport(overrides);
  await persistRun(report, { currentPng: Buffer.from("png") });
  return report.id;
}

function diagnose(input: DiagnoseInput): Promise<Awaited<ReturnType<typeof runDiagnosis>>> {
  return runDiagnosis({
    env: CLEAN_ENV,
    lookupRegisteredSource: () => ({ dir: sourceRoot, from: "uiproof.config.json" }),
    ...input,
  });
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<ComparisonError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ComparisonError);
  expect((error as ComparisonError).code).toBe(code);
  return error as ComparisonError;
}

async function diagnosesOnDisk(): Promise<string[]> {
  try {
    return await readdir(path.join(dataDir, "diagnoses"));
  } catch {
    return [];
  }
}

describe("runDiagnosis — success", () => {
  it("diagnoses a stored audit, verifying the citation against the line it actually read", async () => {
    const auditId = await storeAudit();
    const before = await readFile(path.join(dataDir, "audits", auditId, "audit.json"), "utf8");
    const stub = modelAnswer(diagnosisContent());

    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl });
    const { diagnosis } = result;

    expect(diagnosis.aiGenerated).toBe(true);
    expect(diagnosis.auditId).toBe(auditId);
    expect(diagnosis.reportId).toBeNull();
    expect(diagnosis.sourceRoot).toBe(sourceRoot.replace(/\\/g, path.sep));
    expect(diagnosis.filesScanned).toBe(2);
    expect(diagnosis.filesRead).toContain(FORM_PATH);
    expect(diagnosis.model).toMatchObject({
      provider: "openai-compatible",
      model: "gpt-4o-mini",
      endpointHost: "api.openai.com",
      jsonModeFallback: false,
    });

    const diagnosed = diagnosis.issues.find((issue) => issue.key === A11Y_KEY);
    expect(diagnosed?.diagnosis?.confidence).toBe("medium");
    expect(diagnosed?.diagnosis?.sources).toHaveLength(1);
    expect(diagnosed?.diagnosis?.sources[0]).toMatchObject({ path: FORM_PATH, line: bookingStatusLine() });
    expect(diagnosed?.diagnosis?.sources[0].lineText).toContain('id="booking-status"');
    expect(diagnosed?.diagnosis?.unverifiedSources).toEqual([]);

    // The measured side is copied out unchanged: the model never supplies a number.
    expect(diagnosed?.measured.map((fact) => fact.label)).toEqual([
      "Rule",
      "Impact",
      "WCAG tags",
      "Selector",
      "Element",
      "Runner summary",
      "Measured at viewport(s)",
    ]);
    expect(diagnosed?.measured.find((fact) => fact.label === "Selector")?.value).toBe("#booking-status");

    // A verdict cannot move, because a diagnosis is not part of one.
    expect(await readFile(path.join(dataDir, "audits", auditId, "audit.json"), "utf8")).toBe(before);
  });

  it("persists the diagnosis under its own directory, beside reports and audits", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl });

    expect(result.path).toBe(path.join(dataDir, "diagnoses", result.diagnosis.id, "diagnosis.json"));
    const stored = JSON.parse(await readFile(result.path as string, "utf8")) as Record<string, unknown>;
    expect(stored.aiGenerated).toBe(true);
    expect(stored.issues).toHaveLength(result.diagnosis.issues.length);
    expect(await readdir(path.join(dataDir, "diagnoses"))).toEqual([result.diagnosis.id]);
  });

  it("never records the API key anywhere, including the stored JSON", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl });

    const serialized = await readFile(result.path as string, "utf8");
    expect(serialized).not.toContain(CLEAN_ENV.UIPROOF_AI_API_KEY);
    expect(serialized).not.toContain("Bearer");
  });

  it("sends measured facts and numbered excerpts, and asks for JSON", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    await diagnose({ auditId, fetchImpl: stub.fetchImpl });

    const { system, user } = promptsOf(stub);
    expect(system).toContain("Never invent");
    expect(user).toContain(`- issue key: ${A11Y_KEY}`);
    expect(user).toContain("- Rule: select-name");
    expect(user).toContain("Selector: #booking-status");
    expect(user).toContain(`file: ${FORM_PATH} (excerpt: lines`);
    expect(user).toContain(`${bookingStatusLine()}: `);
    expect(user).toContain('"issues"');
    expect(user.length).toBeLessThan(24_000);
  });

  it("reports an issue the model skipped as null instead of filling it in", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl });

    const responsive = result.diagnosis.issues.find((issue) => issue.kind === "responsive");
    expect(responsive?.diagnosis).toBeNull();
    expect(result.diagnosis.warnings.join(" ")).toContain("did not return a diagnosis for 1 issue(s)");
  });

  it("sends only the requested number of issues", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl, maxIssues: 1 });

    expect(result.diagnosis.issues).toHaveLength(1);
    const { user } = promptsOf(stub);
    expect(user).toContain("Issues to diagnose (1):");
    expect(user).not.toContain("issue key: responsive:mobile");
  });

  it("diagnoses a visual regression from a stored comparison run", async () => {
    const reportId = await storeRun();
    const stub = modelAnswer(
      JSON.stringify({
        issues: [
          {
            key: "visual:regression",
            summary: "The settings header now renders in a different colour.",
            likelyCause: "A token change altered the header background.",
            repairApproach: "Restore the design token, then re-run the comparison.",
            citedFacts: ["Changed pixels: 54686"],
            confidence: "low",
            uncertainty: "The diff image shows a colour change but not which rule produced it.",
            sources: [],
          },
        ],
      }),
    );

    const result = await diagnose({ reportId, fetchImpl: stub.fetchImpl });
    const issue = result.diagnosis.issues[0];
    expect(issue.key).toBe("visual:regression");
    expect(issue.diagnosis?.sources).toEqual([]);
    expect(issue.evidence.map((entry) => entry.url)).toContain("/api/artifacts/run-232b4b94-b7c4-4575-b040-52cf4a7e7f1d/diff.png");
  });

  it("accepts an explicit --source directory even when none is registered", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const result = await runDiagnosis({
      auditId,
      sourceDir: sourceRoot,
      env: CLEAN_ENV,
      fetchImpl: stub.fetchImpl,
      lookupRegisteredSource: () => ({ dir: null, from: null }),
    });
    expect(result.diagnosis.sourceRoot).toBe(sourceRoot.replace(/\\/g, path.sep));
  });

  it("marks a fabricated citation unverified and says so in the warnings", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(
      diagnosisContent({
        sources: [
          { path: "src/app/settings/page.tsx", line: 1, why: "The page that renders the form." },
          { path: "src/server/secrets.ts", line: 9, why: "Where the configuration lives." },
        ],
      }),
    );

    const result = await diagnose({ auditId, fetchImpl: stub.fetchImpl });
    const diagnosis = result.diagnosis.issues.find((issue) => issue.key === A11Y_KEY)?.diagnosis;

    // The page was read (it is a route candidate), so the file-level claim verifies; the
    // invented file does not, and is kept as unverified rather than deleted.
    expect(diagnosis?.sources.map((entry) => entry.path)).toEqual(["src/app/settings/page.tsx"]);
    expect(diagnosis?.unverifiedSources.map((entry) => entry.path)).toEqual(["src/server/secrets.ts"]);
    expect(result.diagnosis.warnings.join(" ")).toContain("could not be verified");
  });
});

describe("runDiagnosis — refusals", () => {
  it("refuses without a configured model, and calls nothing", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const error = await expectFailure(
      runDiagnosis({ auditId, env: {}, fetchImpl: stub.fetchImpl, lookupRegisteredSource: () => ({ dir: sourceRoot, from: "x" }) }),
      "diagnosis_unavailable",
    );

    expect(error.message).toContain("UIPROOF_AI_API_KEY");
    expect(stub.calls).toHaveLength(0);
    expect(await diagnosesOnDisk()).toEqual([]);
  });

  it("refuses when no source directory is registered", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    const error = await expectFailure(
      runDiagnosis({ auditId, env: CLEAN_ENV, fetchImpl: stub.fetchImpl }),
      "diagnosis_source_unregistered",
    );

    expect(error.message).toContain("sourceDir");
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a source directory that does not exist", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    await expectFailure(
      diagnose({ auditId, fetchImpl: stub.fetchImpl, sourceDir: path.join(sourceRoot, "missing") }),
      "diagnosis_source_invalid",
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a run that passed, before contacting the model", async () => {
    const reportId = await storeRun({ status: "pass" });
    const stub = modelAnswer(diagnosisContent());
    const error = await expectFailure(
      diagnose({ reportId, fetchImpl: stub.fetchImpl }),
      "diagnosis_nothing_to_diagnose",
    );

    expect(error.message).toContain("no regression to explain");
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses an unknown report id and an ambiguous request", async () => {
    const stub = modelAnswer(diagnosisContent());
    await expectFailure(diagnose({ reportId: "run-00000000-0000-4000-8000-000000000000", fetchImpl: stub.fetchImpl }), "report_not_found");
    await expectFailure(diagnose({ fetchImpl: stub.fetchImpl }), "invalid_options");
    await expectFailure(diagnose({ reportId: "run-1", auditId: "audit-1", fetchImpl: stub.fetchImpl }), "invalid_options");
    await expectFailure(diagnose({ reportId: "../../etc/passwd", fetchImpl: stub.fetchImpl }), "invalid_report_id");
    expect(stub.calls).toHaveLength(0);
  });

  it("fails on a malformed answer without persisting a partial diagnosis", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer("Sure! Here is the JSON you asked for: {}");
    const error = await expectFailure(diagnose({ auditId, fetchImpl: stub.fetchImpl }), "diagnosis_invalid_response");

    expect(error.message).toContain("did not match the required shape");
    expect(await diagnosesOnDisk()).toEqual([]);
  });

  it("fails when the model invents an issue key", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent({ key: "a11y:invented@#hero" }));
    await expectFailure(diagnose({ auditId, fetchImpl: stub.fetchImpl }), "diagnosis_invalid_response");
    expect(await diagnosesOnDisk()).toEqual([]);
  });

  it("fails when the endpoint keeps answering 5xx", async () => {
    const auditId = await storeAudit();
    const stub = failingModel(503);
    const error = await expectFailure(diagnose({ auditId, fetchImpl: stub.fetchImpl }), "diagnosis_unavailable");

    expect(error.message).toContain("HTTP 503");
    expect(stub.calls).toHaveLength(2);
    expect(await diagnosesOnDisk()).toEqual([]);
  });

  it("leaves the stored audit and its verdict untouched after every failure", async () => {
    const auditId = await storeAudit();
    const before = await readFile(path.join(dataDir, "audits", auditId, "audit.json"), "utf8");

    await expectFailure(diagnose({ auditId, fetchImpl: failingModel(500).fetchImpl }), "diagnosis_unavailable");
    await expectFailure(diagnose({ auditId, fetchImpl: modelAnswer("not json").fetchImpl }), "diagnosis_invalid_response");

    expect(await readFile(path.join(dataDir, "audits", auditId, "audit.json"), "utf8")).toBe(before);
    expect((JSON.parse(before) as { verdict: { status: string } }).verdict.status).toBe("fail");
  });
});

describe("runDiagnosis — source safety in the pipeline", () => {
  it("does not read a file outside the registered directory, even when the report names it", async () => {
    const outside = await makeTree({ "leaked.ts": "export const token = 'should-not-be-read';\n" });
    try {
      const auditId = await storeAudit();
      const stub = modelAnswer(diagnosisContent());
      const result = await runDiagnosis({
        auditId,
        env: CLEAN_ENV,
        fetchImpl: stub.fetchImpl,
        lookupRegisteredSource: () => ({ dir: outside, from: "uiproof.config.json" }),
      });

      expect(result.diagnosis.sourceRoot).toBe(outside.replace(/\\/g, path.sep));
      expect(result.diagnosis.filesRead).toEqual([]);
      const { user } = promptsOf(stub);
      expect(user).toContain("no file in the registered source directory matched");
      expect(user).not.toContain("should-not-be-read");
    } finally {
      await removeTree(outside);
    }
  });

  it("writes nothing into the registered source directory", async () => {
    const auditId = await storeAudit();
    const stub = modelAnswer(diagnosisContent());
    await diagnose({ auditId, fetchImpl: stub.fetchImpl });

    const entries = (await readdir(sourceRoot, { recursive: true })).map((entry) => entry.split(path.sep).join("/"));
    expect(entries.sort()).toEqual(
      [
        "src",
        "src/app",
        "src/app/settings",
        "src/app/settings/page.tsx",
        "src/components",
        "src/components/settings-form.tsx",
      ].sort(),
    );
  });
});

describe("runDiagnosis — persistence can be skipped", () => {
  it("returns the diagnosis without writing when persist is false", async () => {
    const auditId = await storeAudit();
    const result = await diagnose({ auditId, fetchImpl: modelAnswer(diagnosisContent()).fetchImpl, persist: false });

    expect(result.diagnosis.aiGenerated).toBe(true);
    expect(result.path).toBeNull();
    expect(await diagnosesOnDisk()).toEqual([]);
  });
});

describe("the stored diagnosis is an interpretation, not a verdict", () => {
  it("has no status field a gate could read, and leaves the failing verdict alone", async () => {
    const auditId = await storeAudit();
    const result = await diagnose({ auditId, fetchImpl: modelAnswer(diagnosisContent()).fetchImpl });
    const stored = JSON.parse(await readFile(result.path as string, "utf8")) as Record<string, unknown>;

    expect(stored).not.toHaveProperty("status");
    expect(stored).not.toHaveProperty("verdict");
    expect(stored).not.toHaveProperty("pass");
    expect(stored.aiGenerated).toBe(true);

    const audit = JSON.parse(await readFile(path.join(dataDir, "audits", auditId, "audit.json"), "utf8")) as {
      verdict: { status: string };
    };
    expect(audit.verdict.status).toBe("fail");
  });
});
