import { NextResponse } from "next/server";
import { toApiError } from "@/lib/compare/errors";
import type { ApiErrorBody } from "@/lib/compare/types";
import type { GuardFailure } from "./api-guard";

/** One shape for every API failure, including the optional next step for the console. */
export function errorResponse(status: number, code: string, message: string, hint?: string): NextResponse {
  const body: ApiErrorBody = { error: hint ? { code, message, hint } : { code, message } };
  return NextResponse.json(body, { status });
}

export function guardResponse(failure: GuardFailure): NextResponse {
  return errorResponse(failure.status, failure.code, failure.message, failure.hint);
}

/** Maps a thrown engine/storage error onto the documented HTTP status codes. */
export function failureFrom(error: unknown): NextResponse {
  const { status, code, message } = toApiError(error);
  return errorResponse(status, code, message);
}

/** Reads a JSON object body, or returns a 400 for anything else. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | NextResponse> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function isErrorResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}
