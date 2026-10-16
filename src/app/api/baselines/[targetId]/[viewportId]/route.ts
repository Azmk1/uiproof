import { NextResponse } from "next/server";
import { readBaselineManifest } from "@/lib/compare/baselines";
import type { BaselineResponse } from "@/lib/compare/types";
import { failureFrom } from "@/lib/http/api-response";

/**
 * `GET /api/baselines/:targetId/:viewportId` — the approved baseline and its version
 * history. Reading is safe and never changes state; the write endpoints are the ones
 * that are local-only.
 *
 * A pair with nothing approved yet answers `{ baseline: null }` with HTTP 200: "no
 * baseline" is a normal state the console renders, not an error.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string }> },
) {
  const { targetId, viewportId } = await params;
  try {
    const baseline = await readBaselineManifest(targetId, viewportId);
    const payload: BaselineResponse = { baseline };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}
