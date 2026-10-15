import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import { readArtifact } from "@/lib/compare/storage";
import { isValidFileName, isValidReportId } from "@/lib/compare/storage-paths";
import type { ApiErrorBody } from "@/lib/compare/types";

/**
 * Screenshots are served from the data directory. Both path segments are
 * validated against strict patterns before the filesystem is touched, so
 * `../../` style input can never escape the store.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string; file: string }> },
) {
  const { reportId, file } = await params;

  if (!isValidReportId(reportId) || !isValidFileName(file)) {
    const body: ApiErrorBody = { error: { code: "invalid_report_id", message: "Unknown artifact requested" } };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const png = await readArtifact(reportId, file);
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        // Run ids are unique and artifacts are immutable once written.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    const body: ApiErrorBody = { error: { code, message } };
    return NextResponse.json(body, { status });
  }
}
