import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import { resolveCaptureOrigin } from "@/lib/http/origin";
import { isTrustedRequest, readRequestFacts } from "@/lib/http/trusted-request";
import { loadProjectCatalog } from "@/lib/projects/config";
import { runQualityAudit } from "@/lib/quality/audit";
import type { RunAuditRequest, RunAuditResponse } from "@/lib/quality/types";

function errorResponse(status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

/**
 * `POST /api/quality/audit` — measure accessibility and responsive layout of one page.
 *
 * Body: `{ source: { kind, projectId, routeId }, viewports?, policy?, variantId? }`
 *   or  `{ targetId, … }` for a demo fixture (still accepted unchanged).
 *
 * Every audited viewport is captured and scanned, and the returned report carries the
 * evidence behind each measurement: the rule, the element's selector and markup, and the
 * runner's remediation text. The audit is persisted (report + screenshots) so the
 * dashboard can link to the exact evidence later; screenshots live under
 * `/api/audits/<auditId>/<viewport>.png`.
 *
 * A project source is resolved against the local configuration file before anything is
 * captured, so an unregistered project or route is a 400 and never reaches a browser.
 */
export async function POST(request: Request) {
  if (!isTrustedRequest(readRequestFacts(request.headers))) {
    return errorResponse(403, "untrusted_request", "Cross-site requests cannot start an audit.");
  }

  let body: RunAuditRequest;
  try {
    body = (await request.json()) as RunAuditRequest;
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON.");
  }
  if (body === null || typeof body !== "object") {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object.");
  }

  try {
    const projects = await loadProjectCatalog();
    const { report, reportPath } = await runQualityAudit({
      source: body.source,
      targetId: body.targetId,
      variantId: body.variantId,
      viewports: body.viewports,
      policy: body.policy,
      origin: resolveCaptureOrigin(request),
      projects: projects.projects,
      projectConfigError: projects.error,
    });
    const payload: RunAuditResponse = { report, reportPath };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    return errorResponse(status, code, message);
  }
}
