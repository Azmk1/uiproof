import { NextResponse } from "next/server";
import { repairArtifactContentType } from "@/lib/compare/storage-paths";
import { readRepair, readRepairArtifact } from "@/lib/repair/storage";
import { failureFrom } from "@/lib/http/api-response";

/**
 * `GET /api/repairs/:id/artifacts/:name` — one before/after screenshot, diff, patch or
 * rejected model answer.
 *
 * The stored record is the manifest: a name that is not listed in `baselineArtifacts`, in
 * one of the attempt artifact lists, or named by an attempt's patch/reply reference is a
 * 404 even if a file with that name happens to exist. That keeps the artifact surface
 * exactly as large as the evidence UIProof wrote.
 *
 * Screenshots are served as PNG; patches and rejected answers as text, so a rejected
 * attempt can be read back without leaving the console.
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
      repair.attempts.some(
        (attempt) =>
          attempt.artifacts.some((artifact) => artifact.name === name) ||
          attempt.patchArtifact === name ||
          attempt.replyArtifact === name,
      );
    if (!known) {
      return NextResponse.json(
        { error: { code: "repair_not_found", message: `No artifact named ${name} belongs to this repair.` } },
        { status: 404 },
      );
    }

    const bytes = await readRepairArtifact(id, name);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": repairArtifactContentType(name),
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=60",
      },
    });
  } catch (error) {
    return failureFrom(error);
  }
}
