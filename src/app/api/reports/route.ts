import { NextResponse } from "next/server";
import { MAX_HISTORY } from "@/lib/compare/metrics";
import { listReportSummaries } from "@/lib/compare/storage";
import type { ReportsResponse } from "@/lib/compare/types";

/**
 * History is read from disk on every request — no in-memory cache — so a page
 * refresh always reflects what is actually stored.
 */
export async function GET(request: Request) {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const parsedLimit = rawLimit === null ? MAX_HISTORY : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_HISTORY) : MAX_HISTORY;

  const body: ReportsResponse = { reports: await listReportSummaries(limit) };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
