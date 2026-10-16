import { handleActivateBaseline } from "@/lib/http/baseline-handlers";

/**
 * `POST /api/baselines/:targetId/:viewportId/activate` — make an existing version the one
 * new runs compare against.
 *
 * This is the explicit "replace / restore" action: picking an older version rolls the
 * reference back, and every approved image stays on disk either way. Nothing is deleted
 * and no version is ever overwritten, so the history remains auditable.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string }> },
) {
  const { targetId, viewportId } = await params;
  return handleActivateBaseline(request, { kind: "demo", targetId }, viewportId);
}
