import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import { isAuditFileName, isValidAuditId } from "@/lib/compare/storage-paths";
import { readAuditScreenshot } from "@/lib/quality/storage";

/**
 * Audit evidence is served from the data directory: `audit.json` or one
 * `<viewport>.png` per audited viewport. Both path segments are validated against
 * strict patterns before the filesystem is touched, so `../../` style input can
 * never escape the store.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ auditId: string; file: string }> },
) {
  const { auditId, file } = await params;

  if (!isValidAuditId(auditId) || !isAuditFileName(file)) {
    const body: ApiErrorBody = { error: { code: "invalid_report_id", message: "Unknown audit artifact requested" } };
    return NextResponse.json(body, { status: 400 });
  }

  try {
    const data = await readAuditScreenshot(auditId, file);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": file.endsWith(".png") ? "image/png" : "application/json",
        "Content-Length": String(data.byteLength),
        // Audit ids are unique and evidence is immutable once written.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    const body: ApiErrorBody = { error: { code, message } };
    return NextResponse.json(body, { status });
  }
}
