import { handleReadBaselineImage } from "@/lib/http/baseline-handlers";

/**
 * `GET /api/baselines/:targetId/:viewportId/bl-<uuid>.png` — one approved baseline image.
 *
 * The file segment has to match the exact name shape this codebase generates, and the
 * target and viewport have to exist in the catalogue, so no request can walk out of the
 * baseline store. Approved images are immutable, which is what makes the long cache header
 * safe.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string; file: string }> },
) {
  const { targetId, viewportId, file } = await params;
  return handleReadBaselineImage({ kind: "demo", targetId }, viewportId, file);
}
