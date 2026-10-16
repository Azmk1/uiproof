import { handleActivateBaseline } from "@/lib/http/baseline-handlers";

/**
 * `POST /api/baselines/projects/:projectId/:routeId/:viewportId/activate` — replace or
 * restore the reference for one registered route.
 *
 * Restricted to trusted local callers, like every other state-changing baseline endpoint.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string; routeId: string; viewportId: string }> },
) {
  const { projectId, routeId, viewportId } = await params;
  return handleActivateBaseline(request, { kind: "project", projectId, routeId }, viewportId);
}
