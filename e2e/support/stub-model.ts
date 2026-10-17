import { createServer } from "node:http";
import net from "node:net";

/**
 * A deterministic OpenAI-compatible endpoint for the repair integration tests.
 *
 * This is a **test double, not a model**. It answers `/chat/completions` with a fixture
 * patch chosen by the test, so the engine's validation, isolation, measurement and
 * verification can be exercised without network access or credentials. A run against this
 * stub proves the pipeline; it says nothing about how well a real model writes patches.
 * Every test that uses it records that distinction in its report.
 */

export interface StubMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface StubCall {
  readonly call: number;
  readonly system: string;
  readonly user: string;
}

export type StubResponder = (call: StubCall) => string;

export interface StubModel {
  readonly baseUrl: string;
  readonly calls: readonly StubCall[];
  readonly stop: () => Promise<void>;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  for (let port = 4310; port < 4340; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free port for the stub model");
}

export async function startStubModel(responder: StubResponder): Promise<StubModel> {
  const port = await pickPort();
  const calls: StubCall[] = [];

  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", () => {
      let parsed: { messages?: StubMessage[] };
      try {
        parsed = JSON.parse(body) as { messages?: StubMessage[] };
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
        return;
      }
      const messages = parsed.messages ?? [];
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      const call: StubCall = { call: calls.length + 1, system, user };
      calls.push(call);

      let content: string;
      try {
        content = responder(call);
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: (error as Error).message } }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `stub-${call.call}`,
          object: "chat.completion",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Every issue key the repair prompt offered, in the order it offered them. */
export function offeredIssueKeys(prompt: string): string[] {
  return [...prompt.matchAll(/^- issue key: (.+)$/gm)].map((match) => match[1].trim());
}

/** A one-line replacement hunk, written the way a model would write it. */
export function replaceLinePatch(path: string, content: string, oldLine: string, newLines: readonly string[]): string {
  const lines = content.split("\n");
  const matches = lines.map((line, index) => (line === oldLine ? index + 1 : -1)).filter((index) => index !== -1);
  if (matches.length !== 1) {
    throw new Error(`The fixture line occurs ${matches.length} times in ${path}: ${JSON.stringify(oldLine)}`);
  }
  const start = matches[0];
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},1 +${start},${newLines.length} @@`,
    `-${oldLine}`,
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

export interface ProposalFields {
  readonly issueKey: string;
  readonly patch: string;
  readonly title?: string;
  readonly summary?: string;
  readonly explanation?: string;
  readonly expectedImprovement?: string;
  readonly uncertainty?: string | null;
  readonly confidence?: "high" | "medium" | "low";
}

/** The JSON object the engine's validator expects. */
export function proposalJson(fields: ProposalFields): string {
  return JSON.stringify({
    issueKey: fields.issueKey,
    title: fields.title ?? "Fixture repair",
    summary: fields.summary ?? "Apply the fixture's known-good change.",
    explanation: fields.explanation ?? "The excerpt shows the defective line; this replaces it with the corrected markup.",
    expectedImprovement: fields.expectedImprovement ?? "The measured finding should disappear.",
    uncertainty: fields.uncertainty ?? null,
    confidence: fields.confidence ?? "high",
    patch: fields.patch,
  });
}
