import { NextResponse } from "next/server";
import { listAuditSummaries, MAX_AUDIT_HISTORY } from "@/lib/quality/storage";
import type { AuditsResponse } from "@/lib/quality/types";

/**
 * `GET /api/audits?limit=` — audit history, newest first.
 *
 * History is read from disk on every request — no in-memory cache — so a page
 * refresh always reflects what is actually stored.
 */
export async function GET(request: Request) {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const parsedLimit = rawLimit === null ? MAX_AUDIT_HISTORY : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_AUDIT_HISTORY) : MAX_AUDIT_HISTORY;

  const body: AuditsResponse = { audits: await listAuditSummaries(limit) };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
