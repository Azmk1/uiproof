import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import { readDiagnosis } from "@/lib/diagnosis/storage";
import { detectStaleSources } from "@/lib/repair/revision";
import type { DiagnosisResponse } from "@/lib/diagnosis/types";

/**
 * `GET /api/diagnoses/:id` — one stored diagnosis.
 *
 * The same read rules as the other stores: an id that is not a diagnosis id is a 400, an id
 * that is not on disk is a 404. A diagnosis is read-only once written, which is why there
 * is no PATCH, PUT or DELETE here.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const diagnosis = await readDiagnosis(id);
    if (!diagnosis) {
      const body: ApiErrorBody = { error: { code: "report_not_found", message: `No stored diagnosis with id ${id}.` } };
      return NextResponse.json(body, { status: 404 });
    }
    // A stored diagnosis is a snapshot of code, not a live claim. Re-hash the files it
    // read and report anything that moved, instead of letting a citation look current.
    const staleSources = diagnosis.sourceSnapshot
      ? await detectStaleSources(diagnosis.sourceRoot, diagnosis.sourceSnapshot.files)
      : null;
    const payload: DiagnosisResponse = { diagnosis, staleSources };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    const body: ApiErrorBody = { error: { code, message } };
    return NextResponse.json(body, { status });
  }
}
