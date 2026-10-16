import { NextResponse } from "next/server";
import { approveBaseline } from "@/lib/compare/baselines";
import type { ApproveBaselineResponse } from "@/lib/compare/types";
import { requireLocalAdmin } from "@/lib/http/api-guard";
import { failureFrom, guardResponse, isErrorResponse, readJsonObject } from "@/lib/http/api-response";
import { scopeFromRequest } from "@/lib/http/baseline-handlers";

/**
 * `POST /api/baselines` — approve a stored run's `current.png` as the baseline for one
 * scope and viewport.
 *
 * Body, Phase 3: `{ source: { kind, projectId, routeId }, viewportId, sourceReportId, note? }`
 * Body, Phase 1/2: `{ targetId, viewportId, sourceReportId, note? }` — still accepted
 * unchanged, and read as a demo scope.
 *
 * Approval is never triggered by a comparison; it only ever happens here, explicitly, and
 * only from a trusted local request. The run has to belong to the same scope *and* the
 * same viewport, so a Desktop capture can never be adopted as the Mobile reference and one
 * project's run can never become another project's baseline.
 */
export async function POST(request: Request) {
  const guard = requireLocalAdmin(request, "approve a baseline");
  if (guard) return guardResponse(guard);

  const body = await readJsonObject(request);
  if (isErrorResponse(body)) return body;

  try {
    const { manifest, version } = await approveBaseline({
      scope: scopeFromRequest({ targetId: body.targetId, source: body.source }),
      viewportId: body.viewportId,
      sourceReportId: body.sourceReportId,
      note: body.note,
    });
    const payload: ApproveBaselineResponse = { baseline: manifest, version };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}
