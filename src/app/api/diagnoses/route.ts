import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import { describeAvailability } from "@/lib/diagnosis/client";
import { runDiagnosis } from "@/lib/diagnosis/diagnose";
import { listDiagnoses, MAX_DIAGNOSIS_HISTORY } from "@/lib/diagnosis/storage";
import type { DiagnoseRequest, DiagnoseResponse, DiagnosesResponse } from "@/lib/diagnosis/types";
import { requireLocalAdmin } from "@/lib/http/api-guard";
import { loadProjectCatalog, resolveRegisteredSourceDir } from "@/lib/projects/config";
import { findProject } from "@/lib/projects/registry";

function errorResponse(status: number, code: string, message: string, hint?: string) {
  const body: ApiErrorBody = { error: hint ? { code, message, hint } : { code, message } };
  return NextResponse.json(body, { status });
}

/**
 * `GET /api/diagnoses` — diagnosis history, plus whether a model is configured at all.
 *
 * The console asks this before offering the button, so an unconfigured machine shows an
 * explanation instead of a control that cannot work. The response says which model and
 * endpoint host would answer, and never anything about the key.
 *
 * `POST /api/diagnoses` — explain one stored run or audit.
 *
 * Body: `{ reportId }` or `{ auditId }`, optionally `{ maxIssues }`.
 *
 * The source directory is **never** taken from the request. It comes from the project's
 * registration in `uiproof.config.json`, so a page cannot point the investigator at an
 * arbitrary directory on this machine — which is the whole reason the registration exists.
 * The route also requires a local, same-origin request: it spends the configured model's
 * quota and writes to the local store.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_DIAGNOSIS_HISTORY) : 20;
  const scopeKey = url.searchParams.get("scopeKey");

  try {
    const catalog = await loadProjectCatalog();
    const diagnoses = await listDiagnoses(limit, scopeKey);
    const availability = describeAvailability();
    const payload: DiagnosesResponse = {
      diagnoses,
      availability: {
        ...availability,
        sourceRegistration: catalog.projects.some(
          (project) => resolveRegisteredSourceDir(project, catalog.configPath) !== null,
        )
          ? "config"
          : "missing",
      },
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    return errorResponse(status, code, message);
  }
}

export async function POST(request: Request) {
  const denied = requireLocalAdmin(request, "run a diagnosis");
  if (denied) {
    return errorResponse(denied.status, denied.code, denied.message, denied.hint);
  }

  let body: DiagnoseRequest;
  try {
    body = (await request.json()) as DiagnoseRequest;
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON.");
  }
  if (body === null || typeof body !== "object") {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object.");
  }

  try {
    const catalog = await loadProjectCatalog();
    const { diagnosis } = await runDiagnosis({
      reportId: body.reportId,
      auditId: body.auditId,
      maxIssues: body.maxIssues,
      lookupRegisteredSource: (projectId) => {
        const project = projectId ? findProject(catalog.projects, projectId) : undefined;
        return {
          dir: project ? resolveRegisteredSourceDir(project, catalog.configPath) : null,
          from: catalog.configPath,
        };
      },
    });
    const payload: DiagnoseResponse = { diagnosis };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, code, message } = toApiError(error);
    return errorResponse(status, code, message);
  }
}
