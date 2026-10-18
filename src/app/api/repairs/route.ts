import { NextResponse } from "next/server";
import { describeRepairAvailability, probeExecutionAvailability } from "@/lib/repair/config";
import { runRepair } from "@/lib/repair/engine";
import { listRepairs, MAX_REPAIR_HISTORY } from "@/lib/repair/storage";
import type { RepairRequest, RepairsResponse, StartRepairResponse } from "@/lib/repair/types";
import { requireLocalAdmin } from "@/lib/http/api-guard";
import { guardResponse, isErrorResponse, readJsonObject, failureFrom } from "@/lib/http/api-response";
import { loadProjectCatalog, resolveRegisteredSourceDir } from "@/lib/projects/config";
import { findProject } from "@/lib/projects/registry";

/**
 * `GET /api/repairs` — repair history for one scope, plus whether a repair can run here.
 *
 * The panel asks this before offering the button, so an unconfigured machine explains
 * exactly what is missing (a model, a source directory, a sandbox, a build or test
 * command) rather than showing a control that cannot work.
 *
 * `POST /api/repairs` — run a bounded repair for one stored run or audit.
 *
 * Body: `{ reportId }` or `{ auditId }`, optionally `{ maxAttempts: 1 | 2 }`.
 *
 * The source directory and the sandbox command are **never** taken from the request: both
 * come from the project's registration in `uiproof.config.json`. A browser cannot point
 * the engine at an arbitrary directory or start an arbitrary process. The endpoint also
 * requires a local, same-origin request, because it spends model quota, starts a process
 * and writes to the local store.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_REPAIR_HISTORY) : 20;
  const scopeKey = url.searchParams.get("scopeKey");

  try {
    const catalog = await loadProjectCatalog();
    const projectId = scopeKey?.startsWith("project:") ? scopeKey.slice("project:".length).split("/")[0] : null;
    const project =
      (projectId ? findProject(catalog.projects, projectId) : undefined) ??
      catalog.projects.find((entry) => entry.repair) ??
      catalog.projects[0] ??
      null;
    const sourceRegistered = catalog.projects.some(
      (entry) => resolveRegisteredSourceDir(entry, catalog.configPath) !== null,
    );
    const availability = describeRepairAvailability({ project, sourceRegistered });
    // The runtime probe is what turns "container execution is configured" into "container
    // execution can run here". A stopped daemon is reported before the button is offered.
    const execution = await probeExecutionAvailability(project?.repair ?? null).catch(
      (cause: unknown) => ({ ...availability.execution, runtimeAvailable: false, reason: (cause as Error).message }),
    );
    const payload: RepairsResponse = {
      repairs: await listRepairs(limit, scopeKey),
      availability: { ...availability, execution },
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}

export async function POST(request: Request) {
  const denied = requireLocalAdmin(request, "run a repair");
  if (denied) return guardResponse(denied);

  const body = await readJsonObject(request);
  if (isErrorResponse(body)) return body;

  try {
    const catalog = await loadProjectCatalog();
    const { repair } = await runRepair({
      reportId: (body as RepairRequest).reportId,
      auditId: (body as RepairRequest).auditId,
      maxAttempts: (body as RepairRequest).maxAttempts,
      lookupProject: (projectId) => {
        const project = projectId ? findProject(catalog.projects, projectId) : undefined;
        return {
          project: project ?? null,
          sourceDir: project ? resolveRegisteredSourceDir(project, catalog.configPath) : null,
          from: catalog.configPath,
        };
      },
    });
    const payload: StartRepairResponse = { repair };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}

