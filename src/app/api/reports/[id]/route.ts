import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import { readReport } from "@/lib/compare/storage";
import type { ApiErrorBody, ReportResponse } from "@/lib/compare/types";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const report = await readReport(id);
    if (!report) {
      const body: ApiErrorBody = {
        error: { code: "report_not_found", message: `No stored run with id ${id}` },
      };
      return NextResponse.json(body, { status: 404 });
    }
    const body: ReportResponse = { report };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    const body: ApiErrorBody = { error: { code, message } };
    return NextResponse.json(body, { status });
  }
}
