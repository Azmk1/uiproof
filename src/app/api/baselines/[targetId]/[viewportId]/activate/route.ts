import { NextResponse } from "next/server";
import { activateBaselineVersion } from "@/lib/compare/baselines";
import type { ActivateBaselineResponse } from "@/lib/compare/types";
import { requireLocalAdmin } from "@/lib/http/api-guard";
import { failureFrom, guardResponse, isErrorResponse, readJsonObject } from "@/lib/http/api-response";

/**
 * `POST /api/baselines/:targetId/:viewportId/activate` — make an existing version the
 * one new runs compare against.
 *
 * This is the explicit "replace / restore" action: picking an older version rolls the
 * reference back, and every approved image stays on disk either way. Nothing is deleted
 * and no version is ever overwritten, so the history remains auditable.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string }> },
) {
  const guard = requireLocalAdmin(request, "change the approved baseline");
  if (guard) return guardResponse(guard);

  const { targetId, viewportId } = await params;

  const body = await readJsonObject(request);
  if (isErrorResponse(body)) return body;

  try {
    const baseline = await activateBaselineVersion({ targetId, viewportId, versionId: body.versionId });
    const payload: ActivateBaselineResponse = { baseline };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}
