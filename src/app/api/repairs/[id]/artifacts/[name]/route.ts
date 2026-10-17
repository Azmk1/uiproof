import { NextResponse } from "next/server";
import { readRepair, readRepairArtifact } from "@/lib/repair/storage";
import { failureFrom } from "@/lib/http/api-response";

/**
 * `GET /api/repairs/:id/artifacts/:name` — one before/after screenshot or diff.
 *
 * The stored record is the manifest: a name that is not listed in `baselineArtifacts` or
 * in one of the attempt artifact lists is a 404 even if a file with that name happens to
 * exist. That keeps the artifact surface exactly as large as the evidence UIProof wrote.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await context.params;
  try {
    const repair = await readRepair(id);
    if (!repair) {
      return NextResponse.json(
        { error: { code: "repair_not_found", message: `No stored repair with id ${id}.` } },
        { status: 404 },
      );
    }

    const known =
      repair.baselineArtifacts.some((artifact) => artifact.name === name) ||
      repair.attempts.some((attempt) => attempt.artifacts.some((artifact) => artifact.name === name));
    if (!known) {
      return NextResponse.json(
        { error: { code: "repair_not_found", message: `No artifact named ${name} belongs to this repair.` } },
        { status: 404 },
      );
    }

    const png = await readRepairArtifact(id, name);
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
        "cache-control": "private, max-age=60",
      },
    });
  } catch (error) {
    return failureFrom(error);
  }
}
