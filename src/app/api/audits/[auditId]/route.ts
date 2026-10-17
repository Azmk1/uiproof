import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import { readAudit } from "@/lib/quality/storage";
import type { AuditResponse } from "@/lib/quality/types";

/**
 * `GET /api/audits/:auditId` — one stored audit, measurements and evidence together.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;
  try {
    const report = await readAudit(auditId);
    if (!report) {
      const body: ApiErrorBody = {
        error: { code: "report_not_found", message: `No stored audit with id ${auditId}` },
      };
      return NextResponse.json(body, { status: 404 });
    }
    const body: AuditResponse = { report };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    const body: ApiErrorBody = { error: { code, message } };
    return NextResponse.json(body, { status });
  }
}
