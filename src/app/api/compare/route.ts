import { NextResponse } from "next/server";
import { runComparison } from "@/lib/compare/engine";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody, RunComparisonRequest } from "@/lib/compare/types";
import { resolveCaptureOrigin } from "@/lib/http/origin";
import { isTrustedRequest, readRequestFacts } from "@/lib/http/trusted-request";
import { loadProjectCatalog } from "@/lib/projects/config";

function errorResponse(status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

/**
 * `POST /api/compare` — run one comparison or capture.
 *
 * Body, Phase 3: `{ source: { kind, projectId, routeId }, viewportId?, mode?, maxDiffPercent? }`
 * Body, Phase 1/2: `{ targetId, viewportId?, mode?, variantId?, maxDiffPercent? }` — still
 * accepted unchanged, and read as a demo target.
 *
 * A project source is resolved against the local configuration file before anything is
 * captured, so an unregistered project or route is a 400 and never reaches a browser.
 */
export async function POST(request: Request) {
  if (!isTrustedRequest(readRequestFacts(request.headers))) {
    return errorResponse(403, "untrusted_request", "Cross-site requests cannot start a comparison.");
  }

  let body: RunComparisonRequest;
  try {
    body = (await request.json()) as RunComparisonRequest;
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON.");
  }
  if (body === null || typeof body !== "object") {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object.");
  }

  try {
    const projects = await loadProjectCatalog();
    const report = await runComparison({
      targetId: body.targetId,
      source: body.source,
      viewportId: body.viewportId,
      maxDiffPercent: body.maxDiffPercent,
      // Both optional: a Phase 1 body (target + viewport + tolerance) still runs the
      // fixture comparison exactly as before.
      mode: body.mode,
      variantId: body.variantId,
      origin: resolveCaptureOrigin(request),
      projects: projects.projects,
      projectConfigError: projects.error,
    });
    return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    return errorResponse(status, code, message);
  }
}
