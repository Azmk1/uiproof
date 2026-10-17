/** Structured failures the API layer maps onto HTTP status codes. */

export type ComparisonErrorCode =
  | "invalid_target"
  | "invalid_viewport"
  | "invalid_options"
  | "mode_unavailable"
  | "untrusted_request"
  | "local_only"
  | "invalid_report_id"
  | "report_not_found"
  | "baseline_not_found"
  | "baseline_unreadable"
  | "baseline_source_mismatch"
  | "baseline_version_unknown"
  | "baseline_conflict"
  | "browser_unavailable"
  | "capture_failed"
  | "capture_redirected"
  | "comparison_failed"
  | "storage_failed"
  // Phase 3: registered local applications.
  | "project_not_registered"
  | "route_not_registered"
  | "project_config_invalid"
  | "project_unreachable"
  // Phase 4: portable baselines.
  | "baseline_integrity_failed"
  | "baseline_version_conflict"
  | "portable_bundle_invalid"
  // Phase 5: accessibility and responsive quality checks.
  | "quality_unavailable"
  | "quality_failed"
  | "quality_policy_invalid"
  // Phase 7: the optional AI diagnosis.
  | "diagnosis_unavailable"
  | "diagnosis_invalid_response"
  | "diagnosis_source_unregistered"
  | "diagnosis_source_invalid"
  | "diagnosis_nothing_to_diagnose"
  | "diagnosis_context_too_large"
  // Phase 8: isolated repair proposals and verification.
  | "repair_unavailable"
  | "repair_not_found"
  | "repair_source_unregistered"
  | "repair_source_invalid"
  | "repair_source_changed"
  | "repair_nothing_to_repair"
  | "repair_invalid_response"
  | "repair_patch_rejected"
  | "repair_scope_violation"
  | "repair_limits_exceeded"
  | "repair_sandbox_failed"
  | "repair_measurement_failed";

const STATUS_BY_CODE: Record<ComparisonErrorCode, number> = {
  invalid_target: 400,
  invalid_viewport: 400,
  invalid_options: 400,
  mode_unavailable: 400,
  untrusted_request: 403,
  local_only: 403,
  invalid_report_id: 400,
  report_not_found: 404,
  baseline_not_found: 404,
  baseline_unreadable: 500,
  baseline_source_mismatch: 400,
  baseline_version_unknown: 400,
  baseline_conflict: 409,
  browser_unavailable: 503,
  capture_failed: 502,
  capture_redirected: 502,
  comparison_failed: 500,
  storage_failed: 500,
  project_not_registered: 400,
  route_not_registered: 400,
  project_config_invalid: 500,
  project_unreachable: 502,
  baseline_integrity_failed: 400,
  baseline_version_conflict: 409,
  portable_bundle_invalid: 400,
  quality_unavailable: 503,
  quality_failed: 500,
  quality_policy_invalid: 400,
  // A diagnosis is optional infrastructure: no model, a refused request or an unusable
  // answer is a service failure (503/502), never a verdict about the page.
  diagnosis_unavailable: 503,
  diagnosis_invalid_response: 502,
  diagnosis_source_unregistered: 400,
  diagnosis_source_invalid: 400,
  diagnosis_nothing_to_diagnose: 400,
  diagnosis_context_too_large: 400,
  // A repair is optional infrastructure too. A model or sandbox that is missing is a
  // service failure; a patch that is unsafe or malformed is the caller's problem.
  repair_unavailable: 503,
  repair_not_found: 404,
  repair_source_unregistered: 400,
  repair_source_invalid: 400,
  repair_source_changed: 409,
  repair_nothing_to_repair: 400,
  repair_invalid_response: 502,
  repair_patch_rejected: 400,
  repair_scope_violation: 400,
  repair_limits_exceeded: 400,
  repair_sandbox_failed: 502,
  repair_measurement_failed: 502,
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
