import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Pure image maths shared by the engine.
 *
 * Nothing in this module touches the filesystem or a browser, which keeps the
 * comparison itself unit testable with synthetic PNG buffers.
 */

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export type Rgba = readonly [number, number, number, number];

const WHITE: Rgba = [255, 255, 255, 255];

export class ImageDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageDecodeError";
  }
}

export function decodePng(input: Buffer): DecodedImage {
  let png: PNG;
  try {
    png = PNG.sync.read(input);
  } catch (cause) {
    throw new ImageDecodeError("Screenshot could not be decoded as PNG", { cause });
  }
  if (png.width <= 0 || png.height <= 0) {
    throw new ImageDecodeError("Screenshot has no pixels");
  }
  return { width: png.width, height: png.height, data: png.data };
}

function createFilledBuffer(width: number, height: number, fill: Rgba): Buffer {
  const [r, g, b, a] = fill;
  const length = width * height * 4;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}

/** Puts an image on a white canvas of the given size, anchored top-left. */
function padImage(image: DecodedImage, width: number, height: number, fill: Rgba): DecodedImage {
  const data = createFilledBuffer(width, height, fill);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = y * rowBytes;
    image.data.copy(data, y * width * 4, sourceStart, sourceStart + rowBytes);
  }
  return { width, height, data };
}

export interface NormalizedPair {
  readonly baseline: DecodedImage;
  readonly current: DecodedImage;
  readonly width: number;
  readonly height: number;
  /** True when the two captures had different pixel dimensions. */
  readonly dimensionsChanged: boolean;
}

/**
 * pixelmatch requires identical dimensions. Page height can legitimately differ
 * between two captures, so instead of failing we pad the smaller image on white
 * and report that the dimensions changed.
 */
export function normalizeImagePair(
  baseline: DecodedImage,
  current: DecodedImage,
  fill: Rgba = WHITE,
): NormalizedPair {
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const fits = (image: DecodedImage) => image.width === width && image.height === height;
  if (fits(baseline) && fits(current)) {
    return { baseline, current, width, height, dimensionsChanged: false };
  }
  return {
    baseline: padImage(baseline, width, height, fill),
    current: padImage(current, width, height, fill),
    width,
    height,
    dimensionsChanged: true,
  };
}

export interface CompareOptions {
  /** Perceptual colour distance (0–1) passed straight to pixelmatch. */
  readonly pixelThreshold?: number;
}

export interface CompareImagesResult {
  readonly changedPixels: number;
  readonly comparedPixels: number;
  readonly changePercentage: number;
  readonly dimensionsChanged: boolean;
  readonly width: number;
  readonly height: number;
  readonly baselineSize: ImageSize;
  readonly currentSize: ImageSize;
  readonly diffPng: Buffer;
}

export const DIFF_COLOR: Rgba = [220, 38, 38, 255];
export const ANTI_ALIAS_COLOR: Rgba = [250, 204, 21, 255];

/**
 * Decodes both screenshots, matches their dimensions, runs pixelmatch and
 * returns the highlighted difference image plus the raw changed-pixel count.
 */
export function compareImages(
  baselinePng: Buffer,
  currentPng: Buffer,
  options: CompareOptions = {},
): CompareImagesResult {
  const baseline = decodePng(baselinePng);
  const current = decodePng(currentPng);
  const pair = normalizeImagePair(baseline, current);
  const comparedPixels = pair.width * pair.height;

  const diffData = Buffer.alloc(comparedPixels * 4);
  const changedPixels = pixelmatch(
    pair.baseline.data,
    pair.current.data,
    diffData,
    pair.width,
    pair.height,
    {
      threshold: options.pixelThreshold ?? 0.1,
      includeAA: false,
      alpha: 0.32,
      diffColor: [DIFF_COLOR[0], DIFF_COLOR[1], DIFF_COLOR[2]],
      aaColor: [ANTI_ALIAS_COLOR[0], ANTI_ALIAS_COLOR[1], ANTI_ALIAS_COLOR[2]],
    },
  );

  const diffImage = new PNG({ width: pair.width, height: pair.height });
  diffImage.data = diffData;

  return {
    changedPixels,
    comparedPixels,
    changePercentage: comparedPixels > 0 ? (changedPixels / comparedPixels) * 100 : 0,
    dimensionsChanged: pair.dimensionsChanged,
    width: pair.width,
    height: pair.height,
    baselineSize: { width: baseline.width, height: baseline.height },
    currentSize: { width: current.width, height: current.height },
    diffPng: PNG.sync.write(diffImage),
  };
}
