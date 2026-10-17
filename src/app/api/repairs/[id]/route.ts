import { NextResponse } from "next/server";
import type { ApiErrorBody } from "@/lib/compare/types";
import { readRepair } from "@/lib/repair/storage";
import type { RepairResponse } from "@/lib/repair/types";
import { failureFrom } from "@/lib/http/api-response";

/**
 * `GET /api/repairs/:id` — one stored repair, read-only.
 *
 * The same rules as the other stores: an id that is not a repair id is a 400, an id that
 * is not on disk is a 404. There is no PATCH, PUT or DELETE: a repair record is evidence,
 * and a patch becomes real only when a developer applies the exported file by hand.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const repair = await readRepair(id);
    if (!repair) {
      const body: ApiErrorBody = {
        error: { code: "repair_not_found", message: `No stored repair with id ${id}.` },
      };
      return NextResponse.json(body, { status: 404 });
    }
    const payload: RepairResponse = { repair };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureFrom(error);
  }
}
