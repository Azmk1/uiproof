import { createHash } from "node:crypto";
import { decodePng } from "./diff";
import { ComparisonError } from "./errors";

/**
 * Content identity for stored images.
 *
 * An approved baseline that cannot be checked byte-for-byte is not portable: a copied
 * bundle could be truncated, half-transferred or edited, and importing it would quietly
 * install a reference nobody approved. Every portable version therefore carries the
 * SHA-256 of its PNG, and an import verifies it before anything is written.
 */

export const BASELINE_PORTABLE_FORMAT = "uiproof-baselines";
export const BASELINE_PORTABLE_FORMAT_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export interface ExpectedImage {
  readonly sha256?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Proves one PNG is exactly the image the metadata claims, and returns its real size.
 * Throws a typed `baseline_integrity_failed` rather than returning a boolean, because
 * every caller that reaches this point has already decided the image must be usable.
 */
export function verifyImageIntegrity(png: Buffer, expected: ExpectedImage, what: string): { width: number; height: number } {
  if (expected.bytes !== undefined && png.byteLength !== expected.bytes) {
    throw new ComparisonError(
      "baseline_integrity_failed",
      `${what} is ${png.byteLength} bytes but the metadata says ${expected.bytes}.`,
    );
  }
  if (expected.sha256 !== undefined) {
    if (!isSha256(expected.sha256)) {
      throw new ComparisonError("baseline_integrity_failed", `${what} has an unusable SHA-256 in the metadata.`);
    }
    const actual = sha256Hex(png);
    if (actual !== expected.sha256) {
      throw new ComparisonError(
        "baseline_integrity_failed",
        `${what} does not match its recorded SHA-256 (expected ${expected.sha256}, found ${actual}).`,
      );
    }
  }

  let size: { width: number; height: number };
  try {
    const decoded = decodePng(png);
    size = { width: decoded.width, height: decoded.height };
  } catch (cause) {
    throw new ComparisonError(
      "baseline_integrity_failed",
      `${what} is not a decodable PNG, so it cannot be used as a reference image.`,
      { cause },
    );
  }

  if (expected.width !== undefined && size.width !== expected.width) {
    throw new ComparisonError(
      "baseline_integrity_failed",
      `${what} is ${size.width}px wide but the metadata says ${expected.width}px.`,
    );
  }
  if (expected.height !== undefined && size.height !== expected.height) {
    throw new ComparisonError(
      "baseline_integrity_failed",
      `${what} is ${size.height}px tall but the metadata says ${expected.height}px.`,
    );
  }

  return size;
}
