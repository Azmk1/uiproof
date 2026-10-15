/** Structured failures the API layer maps onto HTTP status codes. */

export type ComparisonErrorCode =
  | "invalid_target"
  | "invalid_viewport"
  | "invalid_options"
  | "untrusted_request"
  | "invalid_report_id"
  | "report_not_found"
  | "browser_unavailable"
  | "capture_failed"
  | "comparison_failed"
  | "storage_failed";

const STATUS_BY_CODE: Record<ComparisonErrorCode, number> = {
  invalid_target: 400,
  invalid_viewport: 400,
  invalid_options: 400,
  untrusted_request: 403,
  invalid_report_id: 400,
  report_not_found: 404,
  browser_unavailable: 503,
  capture_failed: 502,
  comparison_failed: 500,
  storage_failed: 500,
};

export class ComparisonError extends Error {
  readonly code: ComparisonErrorCode;
  readonly status: number;

  constructor(code: ComparisonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ComparisonError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function toApiError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ComparisonError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof RangeError) {
    return { status: 400, code: "invalid_request", message: error.message };
  }
  const message = error instanceof Error ? error.message : "Unexpected engine failure";
  return { status: 500, code: "internal_error", message };
}
