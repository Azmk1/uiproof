import { baselineApiPath, sourceRequest, type SourceSelection } from "@/lib/compare/source-selection";
import type {
  ActivateBaselineResponse,
  ApiErrorBody,
  ApproveBaselineResponse,
  BaselineResponse,
  CatalogResponse,
  ComparisonMode,
  ComparisonReport,
  ReportResponse,
  ReportsResponse,
} from "@/lib/compare/types";
import type {
  DiagnoseResponse,
  DiagnosesResponse,
  DiagnosisResponse,
} from "@/lib/diagnosis/types";
import type { AuditResponse, AuditsResponse, RunAuditResponse } from "@/lib/quality/types";

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
  /** A demo fixture target, or a route of a registered local application. */
  readonly selection: SourceSelection;
  readonly viewportId: string;
  readonly maxDiffPercent: number;
  readonly mode: ComparisonMode;
  readonly variantId: string | null;
}

export async function createComparison(input: RunComparisonInput): Promise<ComparisonReport> {
  const response = await requestJson<{ report: ComparisonReport }>("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: sourceRequest(input.selection),
      viewportId: input.viewportId,
      maxDiffPercent: input.maxDiffPercent,
      mode: input.mode,
      variantId: input.variantId,
    }),
  });
  return response.report;
}

/** The approved baseline (and its history) for one source/viewport pair. */
export async function fetchBaseline(selection: SourceSelection, viewportId: string): Promise<BaselineResponse> {
  return requestJson<BaselineResponse>(baselineApiPath(selection, viewportId));
}

export interface ApproveBaselineInput {
  readonly selection: SourceSelection;
  readonly viewportId: string;
  readonly sourceReportId: string;
  readonly note?: string;
}

/** Explicitly adopts a stored run's capture as a new baseline version. */
export async function approveBaseline(input: ApproveBaselineInput): Promise<ApproveBaselineResponse> {
  return requestJson<ApproveBaselineResponse>("/api/baselines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: sourceRequest(input.selection),
      viewportId: input.viewportId,
      sourceReportId: input.sourceReportId,
      note: input.note,
    }),
  });
}

export interface RunAuditInput {
  /** A demo fixture target, or a route of a registered local application. */
  readonly selection: SourceSelection;
  readonly variantId?: string | null;
}

/**
 * Measures accessibility and responsive layout at every viewport preset. The audit is
 * persisted — report and screenshots — so the result's evidence links stay valid.
 */
export function createAudit(input: RunAuditInput): Promise<RunAuditResponse> {
  return requestJson<RunAuditResponse>("/api/quality/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: sourceRequest(input.selection), variantId: input.variantId ?? null }),
  });
}

/** Audit history, newest first. */
export function fetchAudits(limit?: number): Promise<AuditsResponse> {
  const query = typeof limit === "number" ? `?limit=${encodeURIComponent(limit)}` : "";
  return requestJson<AuditsResponse>(`/api/audits${query}`);
}

/** One stored audit: measurements and the evidence behind them. */
export function fetchAudit(id: string): Promise<AuditResponse> {
  return requestJson<AuditResponse>(`/api/audits/${encodeURIComponent(id)}`);
}

/**
 * Diagnosis history for one scope, with whether a model is configured at all.
 *
 * The console asks this before offering the button, so an unconfigured machine explains
 * itself instead of showing a control that cannot work.
 */
export function fetchDiagnoses(scopeKey?: string | null): Promise<DiagnosesResponse> {
  const query = scopeKey ? `?scopeKey=${encodeURIComponent(scopeKey)}` : "";
  return requestJson<DiagnosesResponse>(`/api/diagnoses${query}`);
}

/** One stored diagnosis, read-only. */
export function fetchDiagnosis(id: string): Promise<DiagnosisResponse> {
  return requestJson<DiagnosisResponse>(`/api/diagnoses/${encodeURIComponent(id)}`);
}

/**
 * Asks the configured model to explain a stored run or audit. The source directory is
 * resolved server-side from the registration; the browser cannot name one.
 */
export function createDiagnosis(input: {
  readonly reportId?: string;
  readonly auditId?: string;
  readonly maxIssues?: number;
}): Promise<DiagnoseResponse> {
  return requestJson<DiagnoseResponse>("/api/diagnoses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Makes an existing version active again — the explicit replace/restore action. */
export async function activateBaselineVersion(input: {
  readonly selection: SourceSelection;
  readonly viewportId: string;
  readonly versionId: string;
}): Promise<ActivateBaselineResponse> {
  return requestJson<ActivateBaselineResponse>(
    `${baselineApiPath(input.selection, input.viewportId)}/activate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: input.versionId }),
    },
  );
}
