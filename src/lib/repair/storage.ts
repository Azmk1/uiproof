import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComparisonError } from "@/lib/compare/errors";
import {
  REPAIR_FILENAME,
  isRepairArtifactName,
  isValidRepairId,
  resolveRepairArtifactPath,
  resolveRepairDir,
  resolveRepairRecordPath,
  resolveRepairsDir,
} from "@/lib/compare/storage-paths";
import type { RepairRun, RepairSummary, RepairVerdict } from "./types";

/**
 * Filesystem persistence for repair runs:
 *
 *   <data>/repairs/<repair-…>/repair.json        the full record: attempts, measurements, verdicts
 *   <data>/repairs/<repair-…>/attempt-1.patch    the model's diff, verbatim
 *   <data>/repairs/<repair-…>/before-*.png       the unmodified sandbox, measured
 *   <data>/repairs/<repair-…>/after-*.png        the patched sandbox, measured
 *   <data>/repairs/<repair-…>/*-diff.png         visual differences against the approved baseline
 *
 * A repair record is append-only once written, and it is never read by the comparison,
 * audit or baseline code. Deleting the whole directory would not change a single pass or
 * fail; it would only erase the evidence.
 */

const MAX_SCANNED_REPAIRS = 100;
export const MAX_REPAIR_HISTORY = 50;

const VERDICT_ORDER: readonly RepairVerdict[] = ["verified", "partially-improved", "rejected", "unverified"];

export function repairId(): string {
  return `repair-${crypto.randomUUID()}`;
}

export function repairPatchName(attempt: number): string {
  if (attempt !== 1 && attempt !== 2) throw new RangeError(`Invalid repair attempt number: ${attempt}`);
  return `attempt-${attempt}.patch`;
}

/**
 * The stored file name of an unusable model answer. It is written whenever an attempt
 * produced an answer that could not become a patch, so a rejected attempt is inspectable
 * even when there is no diff to inspect.
 */
export function repairReplyName(attempt: number): string {
  if (attempt !== 1 && attempt !== 2) throw new RangeError(`Invalid repair attempt number: ${attempt}`);
  return `attempt-${attempt}-reply.txt`;
}

/** One sentence explaining why the run ended with its verdict, for the history row. */
export function reasonOf(repair: RepairRun): string {
  const attempt = repair.attempts.find((entry) => entry.attempt === repair.verifiedAttempt) ?? repair.attempts.at(-1);
  if (!attempt) return "No attempt was made.";
  const verification = attempt.verification;
  if (verification && verification.reasons.length > 0) return verification.reasons[0];
  if (attempt.rejection) return attempt.rejection;
  return attempt.verdict === "verified" ? "A verified repair was measured." : "No verified repair was produced.";
}

export function summarizeRepair(repair: RepairRun): RepairSummary {
  return {
    id: repair.id,
    createdAt: repair.createdAt,
    targetKind: repair.target.kind,
    targetId: repair.target.id,
    scopeKey: repair.target.scopeKey,
    sourceLabel: repair.sourceLabel,
    status: repair.status,
    attempts: repair.attempts.length,
    verifiedAttempt: repair.verifiedAttempt,
    commitSha: repair.revision.commitSha,
    originalUnchanged: repair.originalUnchanged,
    executionMode: repair.execution?.mode ?? "host",
    reason: reasonOf(repair),
  };
}

/** Writes the record and every artifact as one directory. */
export async function persistRepair(input: {
  readonly repair: RepairRun;
  readonly patches: Readonly<Record<string, string>>;
  readonly images: readonly { readonly name: string; readonly buffer: Buffer }[];
}): Promise<string> {
  const directory = resolveRepairDir(input.repair.id);
  try {
    await mkdir(directory, { recursive: true });
    const writes: Array<Promise<unknown>> = [
      writeFile(path.join(directory, REPAIR_FILENAME), `${JSON.stringify(input.repair, null, 2)}\n`, "utf8"),
    ];
    for (const [name, text] of Object.entries(input.patches)) {
      if (!isRepairArtifactName(name)) throw new RangeError(`Invalid repair patch name: ${name}`);
      writes.push(writeFile(path.join(directory, name), text.endsWith("\n") ? text : `${text}\n`, "utf8"));
    }
    for (const image of input.images) {
      if (!isRepairArtifactName(image.name)) throw new RangeError(`Invalid repair artifact name: ${image.name}`);
      writes.push(writeFile(path.join(directory, image.name), image.buffer));
    }
    await Promise.all(writes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ComparisonError("storage_failed", `Could not persist the repair: ${message}`, { cause });
  }
  return path.join(directory, REPAIR_FILENAME);
}

export async function readRepair(id: unknown): Promise<RepairRun | null> {
  if (!isValidRepairId(id)) {
    throw new ComparisonError("invalid_report_id", `Invalid repair id: ${String(id)}`);
  }
  try {
    return JSON.parse(await readFile(resolveRepairRecordPath(id), "utf8")) as RepairRun;
  } catch {
    return null;
  }
}

/** One stored artifact of a repair, guarded against traversal like a run artifact. */
export async function readRepairArtifact(id: unknown, name: unknown): Promise<Buffer> {
  if (!isValidRepairId(id) || !isRepairArtifactName(name)) {
    throw new ComparisonError("invalid_report_id", "Unknown repair artifact requested");
  }
  try {
    return await readFile(resolveRepairArtifactPath(id, name));
  } catch (cause) {
    throw new ComparisonError("repair_not_found", "That repair artifact is no longer on disk", { cause });
  }
}

function verifiedRank(repair: RepairRun): number {
  return repair.status === "verified" ? 0 : VERDICT_ORDER.indexOf(repair.status) + 1;
}

/** Newest-first repair history, skipping anything that is not a usable record. */
export async function listRepairs(limit: number, scopeKey?: string | null): Promise<RepairSummary[]> {
  let entries: string[];
  try {
    const dirents = await readdir(resolveRepairsDir(), { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isDirectory() && isValidRepairId(entry.name))
      .map((entry) => entry.name)
      .slice(0, MAX_SCANNED_REPAIRS);
  } catch {
    return [];
  }

  const loaded = await Promise.all(
    entries.map(async (entry) => {
      try {
        return JSON.parse(await readFile(path.join(resolveRepairDir(entry), REPAIR_FILENAME), "utf8")) as RepairRun;
      } catch {
        return null;
      }
    }),
  );

  return loaded
    .filter((repair): repair is RepairRun => repair !== null)
    .filter((repair) => !scopeKey || repair.target.scopeKey === scopeKey)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || verifiedRank(left) - verifiedRank(right))
    .slice(0, limit)
    .map(summarizeRepair);
}
