import { NextResponse } from "next/server";
import { readBaselineImage } from "@/lib/compare/baselines";
import { isValidBaselineVersionFileName } from "@/lib/compare/baseline-paths";
import { errorResponse, failureFrom } from "@/lib/http/api-response";

/**
 * `GET /api/baselines/:targetId/:viewportId/bl-<uuid>.png` — one approved baseline image.
 *
 * The file segment has to match the exact name shape this codebase generates, and the
 * target and viewport have to exist in the catalogue, so no request can walk out of the
 * baseline store. Approved images are immutable, which is what makes the long cache
 * header safe.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string; viewportId: string; file: string }> },
) {
  const { targetId, viewportId, file } = await params;

  if (!isValidBaselineVersionFileName(file)) {
    return errorResponse(400, "baseline_version_unknown", "Unknown baseline image requested");
  }

  try {
    const png = await readBaselineImage(targetId, viewportId, file);
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return failureFrom(error);
  }
}
