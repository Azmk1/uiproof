import { handleReadBaselineImage } from "@/lib/http/baseline-handlers";

/**
 * `GET /api/baselines/projects/:projectId/:routeId/:viewportId/bl-<uuid>.png` — one
 * approved baseline image of a registered route.
 *
 * The file name must match the exact shape this codebase generates and both ids must match
 * the id patterns, so no request can reach outside the baseline store.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; routeId: string; viewportId: string; file: string }> },
) {
  const { projectId, routeId, viewportId, file } = await params;
  return handleReadBaselineImage({ kind: "project", projectId, routeId }, viewportId, file);
}
