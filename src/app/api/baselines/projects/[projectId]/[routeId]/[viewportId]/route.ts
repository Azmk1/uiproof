import { handleReadManifest } from "@/lib/http/baseline-handlers";

/**
 * `GET /api/baselines/projects/:projectId/:routeId/:viewportId` — the approved baseline of
 * one registered project route and its version history.
 *
 * Project baselines are namespaced under `projects/` so they can never share storage — or
 * a lookup — with a demo target. Nothing approved answers `{ baseline: null }` with HTTP
 * 200, which is the state a freshly registered route is in.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; routeId: string; viewportId: string }> },
) {
  const { projectId, routeId, viewportId } = await params;
  return handleReadManifest({ kind: "project", projectId, routeId }, viewportId);
}
