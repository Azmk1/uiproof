import { NextResponse } from "next/server";
import { runComparison } from "@/lib/compare/engine";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody, RunComparisonRequest } from "@/lib/compare/types";
import { resolveCaptureOrigin } from "@/lib/http/origin";
import { isTrustedRequest, readRequestFacts } from "@/lib/http/trusted-request";

function errorResponse(status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

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
    const report = await runComparison({
      targetId: body.targetId,
      viewportId: body.viewportId,
      maxDiffPercent: body.maxDiffPercent,
      // Both optional: a Phase 1 body (target + viewport + tolerance) still runs the
      // fixture comparison exactly as before.
      mode: body.mode,
      variantId: body.variantId,
      origin: resolveCaptureOrigin(request),
    });
    return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    return errorResponse(status, code, message);
  }
}
