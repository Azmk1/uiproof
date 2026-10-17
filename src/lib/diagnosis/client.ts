import { ComparisonError } from "@/lib/compare/errors";
import type { DiagnosisAvailability } from "./types";

/**
 * The model client: one interface, any OpenAI-compatible endpoint.
 *
 * UIProof talks to `/chat/completions` and nothing else. That is deliberate — the whole
 * OpenAI-compatible family (OpenAI itself, Azure-style gateways, OpenRouter, Together,
 * Groq, vLLM, Ollama, LM Studio, a company proxy) speaks it, so "which model" is a
 * configuration question rather than a dependency. There is no vendor SDK in this
 * repository and no default that phones home: without a key nothing here is ever called.
 *
 * Everything is bounded: a request timeout, a response size cap, a token cap, and a
 * single retry for the two failure modes that are worth retrying (rate limits and 5xx).
 * The API key is never logged, never stored in a diagnosis, and never part of an error
 * message — only the endpoint's host is recorded.
 */

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
export const DEFAULT_MAX_ISSUES = 4;

const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 180_000;
const MIN_TOKENS = 128;
const MAX_TOKENS = 8_000;
const MAX_ISSUES_LIMIT = 8;
/** A response longer than this is refused rather than parsed. */
export const MAX_RESPONSE_CHARS = 200_000;
const RETRY_DELAY_MS = 400;

export interface ModelConfig {
  readonly apiKey: string;
  /** Base URL without a trailing slash; `/chat/completions` is appended. */
  readonly baseUrl: string;
  readonly endpointHost: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxIssues: number;
}

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Normalises a base URL: http(s), no credentials, no query, no trailing slash. */
function parseBaseUrl(value: string): { baseUrl: string; endpointHost: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return { baseUrl: `${parsed.origin}${pathname}`, endpointHost: parsed.host };
}

export interface ModelConfiguration {
  readonly config: ModelConfig | null;
  /** Why it is not configured, in one sentence a developer can act on. */
  readonly reason: string | null;
}

/**
 * The environment this reads, kept structural so a test can pass a literal. UIProof is not
 * a Node-only library: the same function is used from the server process and from tests.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Reads the configuration from the environment. `UIPROOF_AI_*` wins over the familiar
 * `OPENAI_*` names, so a machine that already has an OpenAI key for something else can
 * still point UIProof at a different endpoint without unsetting it.
 */
export function readModelConfig(env: EnvLike = process.env): ModelConfiguration {
  const apiKey = (env.UIPROOF_AI_API_KEY ?? env.OPENAI_API_KEY ?? "").trim();
  const baseUrlRaw = (env.UIPROOF_AI_BASE_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).trim();
  const model = (env.UIPROOF_AI_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_MODEL).trim();

  const parsed = parseBaseUrl(baseUrlRaw);
  if (!parsed) {
    return {
      config: null,
      reason: `UIPROOF_AI_BASE_URL must be a plain http(s) URL without credentials or a query string, got ${JSON.stringify(baseUrlRaw)}.`,
    };
  }
  if (apiKey.length === 0) {
    return {
      config: null,
      reason:
        "No model is configured. Set UIPROOF_AI_API_KEY (or OPENAI_API_KEY) to enable AI diagnosis; " +
        "UIPROOF_AI_BASE_URL and UIPROOF_AI_MODEL select the endpoint and model.",
    };
  }
  if (model.length === 0) {
    return { config: null, reason: "UIPROOF_AI_MODEL must name a model." };
  }

  return {
    reason: null,
    config: {
      apiKey,
      baseUrl: parsed.baseUrl,
      endpointHost: parsed.endpointHost,
      model,
      timeoutMs: readInt(env.UIPROOF_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxOutputTokens: readInt(env.UIPROOF_AI_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, MIN_TOKENS, MAX_TOKENS),
      maxIssues: readInt(env.UIPROOF_AI_MAX_ISSUES, DEFAULT_MAX_ISSUES, 1, MAX_ISSUES_LIMIT),
    },
  };
}

/** What a caller can say about the model without revealing anything about the key. */
export function describeAvailability(env: EnvLike = process.env): Omit<DiagnosisAvailability, "sourceRegistration"> {
  const { config, reason } = readModelConfig(env);
  return {
    configured: config !== null,
    model: config?.model ?? null,
    endpointHost: config?.endpointHost ?? null,
    reason,
  };
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface ModelReply {
  readonly content: string;
  readonly latencyMs: number;
  readonly jsonModeFallback: boolean;
}

interface RequestOptions {
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly onAttempt?: (info: { readonly attempt: number; readonly status: number | null }) => void;
}

function unavailable(message: string, options?: { cause?: unknown }): ComparisonError {
  return new ComparisonError("diagnosis_unavailable", message, options);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return "";
  }
}

/**
 * One chat completion. Retries once on `429` and `5xx`, and once more without JSON mode
 * when an endpoint rejects `response_format` — some compatible servers implement the
 * schema and not the flag.
 */
export async function requestChatCompletion(
  config: ModelConfig,
  messages: readonly ChatMessage[],
  options: RequestOptions = {},
): Promise<ModelReply> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${config.baseUrl}/chat/completions`;
  const started = Date.now();

  const send = async (useJsonMode: boolean): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          max_tokens: config.maxOutputTokens,
          ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === "AbortError";
      throw unavailable(
        aborted
          ? `The model did not answer within ${config.timeoutMs} ms (endpoint ${config.endpointHost}).`
          : `The model endpoint could not be reached (${config.endpointHost}): ${(cause as Error).message}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let jsonModeFallback = false;
  let attempt = 0;
  let response = await send(true);
  options.onAttempt?.({ attempt, status: response.status });

  if (response.status === 400) {
    const body = await readErrorBody(response);
    if (/response_format/i.test(body)) {
      jsonModeFallback = true;
      attempt += 1;
      response = await send(false);
      options.onAttempt?.({ attempt, status: response.status });
    } else {
      throw unavailable(`The model endpoint rejected the request (400): ${body || "no detail"}`);
    }
  }

  if (response.status === 429 || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    attempt += 1;
    response = await send(jsonModeFallback === false);
    options.onAttempt?.({ attempt, status: response.status });
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    if (response.status === 401 || response.status === 403) {
      throw unavailable(
        `The model endpoint rejected the credentials (HTTP ${response.status}). Check UIPROOF_AI_API_KEY for ${config.endpointHost}.`,
      );
    }
    if (response.status === 404) {
      throw unavailable(
        `No chat-completions endpoint answered at ${config.baseUrl}/chat/completions (HTTP 404). Check UIPROOF_AI_BASE_URL.`,
      );
    }
    throw unavailable(`The model endpoint answered HTTP ${response.status}: ${body || "no detail"}`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw unavailable(`The model answered with more than ${MAX_RESPONSE_CHARS} characters, which UIProof refuses to parse.`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (cause) {
    throw unavailable(`The model endpoint answered with something that is not JSON.`, { cause });
  }

  const content = extractContent(payload);
  if (content === null) {
    throw unavailable("The model answer did not contain a chat completion message.");
  }

  return { content, latencyMs: Date.now() - started, jsonModeFallback };
}

/** Reads `choices[0].message.content`, tolerating the array form some providers use. */
function extractContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? String((part as { text: string }).text) : ""))
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}
