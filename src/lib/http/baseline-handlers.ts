import { NextResponse } from "next/server";
import { activateBaselineVersion, readBaselineImage, readBaselineManifest } from "@/lib/compare/baselines";
import type {
  ActivateBaselineResponse,
  BaselineResponse,
  BaselineScope,
  RunSourceRequest,
} from "@/lib/compare/types";
import { requireLocalAdmin } from "./api-guard";
import { failureFrom, guardResponse, isErrorResponse, readJsonObject } from "./api-response";

/**
 * The baseline endpoints exist twice in the route tree — once at the Phase 2 path
 * (`/api/baselines/:targetId/:viewportId`) and once namespaced for registered projects
 * (`/api/baselines/projects/:projectId/:routeId/:viewportId`). Both resolve to a
 * `BaselineScope` and land here, so there is one implementation of the rules and only
 * the URL shape differs.
 */

/** Narrows a request body's `source` field without trusting its contents. */
function asSourceRequest(value: unknown): RunSourceRequest | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as RunSourceRequest;
}

export async function handleReadManifest(scope: BaselineScope, viewportId: string): Promise<Response> {
  try {
    const baseline = await readBaselineManifest(scope, viewportId);
    const payload: BaselineResponse = { baseline };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}

export async function handleActivateBaseline(
  request: Request,
  scope: BaselineScope,
  viewportId: string,
): Promise<Response> {
  const guard = requireLocalAdmin(request, "change the approved baseline");
  if (guard) return guardResponse(guard);

  const body = await readJsonObject(request);
  if (isErrorResponse(body)) return body;

  try {
    const baseline = await activateBaselineVersion({ scope, viewportId, versionId: body.versionId });
    const payload: ActivateBaselineResponse = { baseline };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}

export async function handleReadBaselineImage(
  scope: BaselineScope,
  viewportId: string,
  file: string,
): Promise<Response> {
  try {
    const png = await readBaselineImage(scope, viewportId, file);
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

/**
 * Turns a request body into a baseline scope. `source` is the Phase 3 spelling; a body
 * with only `targetId` is read as a demo scope, exactly as in Phase 2.
 */
export function scopeFromRequest(input: {
  readonly targetId?: unknown;
  readonly source?: unknown;
}): BaselineScope {
  const source = asSourceRequest(input.source);
  if (source && typeof source === "object") {
    if (source.kind === "project" || (source.kind === undefined && source.projectId !== undefined)) {
      return {
        kind: "project",
        projectId: String(source.projectId ?? ""),
        routeId: String(source.routeId ?? ""),
      };
    }
    if (source.targetId !== undefined) {
      return { kind: "demo", targetId: String(source.targetId) };
    }
  }
  return { kind: "demo", targetId: String(input.targetId ?? "") };
}
