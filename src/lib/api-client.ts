import type {
  ApiErrorBody,
  CatalogResponse,
  ComparisonReport,
  ReportResponse,
  ReportsResponse,
} from "@/lib/compare/types";

/** Thin, typed wrapper around the UIProof HTTP API used by the console. */

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== "object" || candidate === null) return false;
  const error = candidate as { code?: unknown; message?: unknown };
  return typeof error.code === "string" && typeof error.message === "string";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new ApiClientError("Could not reach the UIProof server. Is it still running?", "network_error", 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (isApiErrorBody(payload)) {
      throw new ApiClientError(payload.error.message, payload.error.code, response.status);
    }
    throw new ApiClientError(`The server answered with HTTP ${response.status}.`, "http_error", response.status);
  }

  if (payload === null) {
    throw new ApiClientError("The server returned an unreadable response.", "invalid_response", response.status);
  }

  return payload as T;
}

export function fetchCatalog(): Promise<CatalogResponse> {
  return requestJson<CatalogResponse>("/api/catalog");
}

export function fetchReports(limit?: number): Promise<ReportsResponse> {
  const query = typeof limit === "number" ? `?limit=${encodeURIComponent(limit)}` : "";
  return requestJson<ReportsResponse>(`/api/reports${query}`);
}

export function fetchReport(id: string): Promise<ReportResponse> {
  return requestJson<ReportResponse>(`/api/reports/${encodeURIComponent(id)}`);
}

export interface RunComparisonInput {
  readonly targetId: string;
  readonly viewportId: string;
  readonly maxDiffPercent: number;
}

export async function createComparison(input: RunComparisonInput): Promise<ComparisonReport> {
  const response = await requestJson<{ report: ComparisonReport }>("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.report;
}
