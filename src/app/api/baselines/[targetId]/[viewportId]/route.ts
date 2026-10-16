import { handleReadManifest } from "@/lib/http/baseline-handlers";

/**
 * `GET /api/baselines/:targetId/:viewportId` — the approved baseline of a demo target and
 * its version history. Reading is safe and never changes state; the write endpoints are
 * the ones that are local-only.
 *
 * A pair with nothing approved yet answers `{ baseline: null }` with HTTP 200: "no
 * baseline" is a normal state the console renders, not an error.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string }> },
) {
  const { targetId, viewportId } = await params;
  return handleReadManifest({ kind: "demo", targetId }, viewportId);
}
