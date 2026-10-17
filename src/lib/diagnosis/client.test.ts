import { describe, expect, it } from "vitest";
import { ComparisonError } from "@/lib/compare/errors";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_CHARS,
  describeAvailability,
  readModelConfig,
  requestChatCompletion,
  type ModelConfig,
} from "./client";

/**
 * No network is touched here: every request is answered by a scripted `fetch`, which is
 * also how the failure modes that matter — a missing key, a rejected key, a rate limit, an
 * endpoint that does not understand JSON mode, a hung endpoint — are exercised on purpose.
 */

const CONFIG: ModelConfig = {
  apiKey: "sk-test-not-a-real-key",
  baseUrl: "https://models.example.test/v1",
  endpointHost: "models.example.test",
  model: "gpt-4o-mini",
  timeoutMs: 5_000,
  maxOutputTokens: 300,
  maxIssues: 4,
};

const MESSAGES = [
  { role: "system" as const, content: "You diagnose measured defects. Answer in JSON." },
  { role: "user" as const, content: '{"issues":[{"key":"visual:regression"}]}' },
];

function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function scripted(handler: (call: number, url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = init ?? {};
    calls.push({ url, init: request });
    return handler(calls.length, url, request);
  }) as typeof fetch;
  return { impl, calls };
}

describe("readModelConfig", () => {
  it("refuses to configure anything without a key, and says what to set", () => {
    const { config, reason } = readModelConfig({});
    expect(config).toBeNull();
    expect(reason).toContain("UIPROOF_AI_API_KEY");
    expect(reason).toContain("UIPROOF_AI_BASE_URL");
  });

  it("defaults to OpenAI's endpoint and a documented model", () => {
    const { config } = readModelConfig({ UIPROOF_AI_API_KEY: "sk-test" });
    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      endpointHost: "api.openai.com",
      model: DEFAULT_MODEL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxIssues: 4,
    });
  });

  it("lets UIPROOF_AI_* win over the OPENAI_* names", () => {
    const { config } = readModelConfig({
      OPENAI_API_KEY: "sk-foreign",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4o",
      UIPROOF_AI_API_KEY: "sk-uiproof",
      UIPROOF_AI_BASE_URL: "http://127.0.0.1:11434/v1/",
      UIPROOF_AI_MODEL: "qwen2.5-coder",
    });
    expect(config).toMatchObject({
      apiKey: "sk-uiproof",
      baseUrl: "http://127.0.0.1:11434/v1",
      endpointHost: "127.0.0.1:11434",
      model: "qwen2.5-coder",
    });
  });

  it("clamps the timeout, token cap and issue cap to safe ranges", () => {
    const low = readModelConfig({
      UIPROOF_AI_API_KEY: "sk-test",
      UIPROOF_AI_TIMEOUT_MS: "10",
      UIPROOF_AI_MAX_TOKENS: "1",
      UIPROOF_AI_MAX_ISSUES: "0",
    }).config;
    expect(low).toMatchObject({ timeoutMs: 2_000, maxOutputTokens: 128, maxIssues: 1 });

    const high = readModelConfig({
      UIPROOF_AI_API_KEY: "sk-test",
      UIPROOF_AI_TIMEOUT_MS: "9999999",
      UIPROOF_AI_MAX_TOKENS: "999999",
      UIPROOF_AI_MAX_ISSUES: "99",
    }).config;
    expect(high).toMatchObject({ timeoutMs: 180_000, maxOutputTokens: 8_000, maxIssues: 8 });
  });

  it("refuses a base URL with credentials, a query string or a non-http scheme", () => {
    for (const baseUrl of [
      "https://user:pass@models.example.test/v1",
      "https://models.example.test/v1?key=abc",
      "file:///tmp/models",
      "not a url",
    ]) {
      const { config, reason } = readModelConfig({ UIPROOF_AI_API_KEY: "sk-test", UIPROOF_AI_BASE_URL: baseUrl });
      expect(config).toBeNull();
      expect(reason).toContain("UIPROOF_AI_BASE_URL");
    }
  });

  it("describes availability without ever exposing the key", () => {
    const described = describeAvailability({
      UIPROOF_AI_API_KEY: "sk-super-secret-value",
      UIPROOF_AI_MODEL: "gpt-4o-mini",
    });
    expect(described).toEqual({
      configured: true,
      model: "gpt-4o-mini",
      endpointHost: "api.openai.com",
      reason: null,
    });
    expect(JSON.stringify(described)).not.toContain("sk-super-secret-value");
  });
});

describe("requestChatCompletion", () => {
  it("posts to /chat/completions with the key in the header and parses the message", async () => {
    const { impl, calls } = scripted(() => completion('{"issues":[]}'));
    const reply = await requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl });

    expect(reply.content).toBe('{"issues":[]}');
    expect(reply.jsonModeFallback).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://models.example.test/v1/chat/completions");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CONFIG.apiKey}`);
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: MESSAGES,
    });
  });

  it("accepts the array form of message content", async () => {
    const { impl } = scripted(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: '{"issues":[]}' }] } }] }), {
          status: 200,
        }),
    );
    expect((await requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl })).content).toBe('{"issues":[]}');
  });

  it("retries once when the endpoint rejects response_format", async () => {
    const { impl, calls } = scripted((call) =>
      call === 1
        ? new Response('{"error":"response_format is not supported"}', { status: 400 })
        : completion('{"issues":[]}'),
    );
    const reply = await requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl });

    expect(reply.jsonModeFallback).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1].init.body))).not.toHaveProperty("response_format");
  });

  it("retries once on a rate limit and then succeeds", async () => {
    const { impl, calls } = scripted((call) =>
      call === 1 ? new Response("slow down", { status: 429 }) : completion('{"issues":[]}'),
    );
    const reply = await requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl });
    expect(reply.content).toBe('{"issues":[]}');
    expect(calls).toHaveLength(2);
  });

  it("reports rejected credentials without echoing the key", async () => {
    const { impl } = scripted(() => new Response("invalid api key", { status: 401 }));
    try {
      await requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl });
      throw new Error("expected a refusal");
    } catch (error) {
      const failure = error as ComparisonError;
      expect(failure).toBeInstanceOf(ComparisonError);
      expect(failure.code).toBe("diagnosis_unavailable");
      expect(failure.message).toContain("HTTP 401");
      expect(failure.message).not.toContain(CONFIG.apiKey);
    }
  });

  it("explains a wrong base URL when nothing answers", async () => {
    const { impl } = scripted(() => new Response("not found", { status: 404 }));
    await expect(requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: impl })).rejects.toThrow(
      /UIPROOF_AI_BASE_URL/,
    );
  });

  it("refuses a body that is not JSON or has no completion message", async () => {
    const notJson = scripted(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: notJson.impl })).rejects.toThrow(
      /not JSON/,
    );

    const noChoices = scripted(() => new Response("{}", { status: 200 }));
    await expect(requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: noChoices.impl })).rejects.toThrow(
      /did not contain a chat completion message/,
    );
  });

  it("refuses an enormous response instead of parsing it", async () => {
    const huge = scripted(() => new Response("x".repeat(MAX_RESPONSE_CHARS + 1), { status: 200 }));
    await expect(requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: huge.impl })).rejects.toThrow(
      /more than 200000 characters/,
    );
  });

  it("turns a hung endpoint into a timeout error naming the endpoint", async () => {
    const hung = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as typeof fetch;

    await expect(
      requestChatCompletion({ ...CONFIG, timeoutMs: 20 }, MESSAGES, { fetchImpl: hung }),
    ).rejects.toThrow(/did not answer within 20 ms \(endpoint models.example.test\)/);
  });

  it("reports an unreachable endpoint without a stack trace in the message", async () => {
    const offline = (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { name: "TypeError" });
    }) as typeof fetch;

    await expect(requestChatCompletion(CONFIG, MESSAGES, { fetchImpl: offline })).rejects.toThrow(
      /could not be reached \(models\.example\.test\)/,
    );
  });
});
