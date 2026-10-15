import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ImageDecodeError, compareImages, decodePng, normalizeImagePair } from "./diff";

type Rgba = [number, number, number, number];

const WHITE: Rgba = [255, 255, 255, 255];
const BLUE: Rgba = [30, 64, 175, 255];

function createPng(width: number, height: number, fill: Rgba): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill[0];
    png.data[i + 1] = fill[1];
    png.data[i + 2] = fill[2];
    png.data[i + 3] = fill[3];
  }
  return png;
}

function paintBlock(
  png: PNG,
  block: { x: number; y: number; width: number; height: number },
  color: Rgba,
): void {
  for (let y = block.y; y < block.y + block.height; y += 1) {
    for (let x = block.x; x < block.x + block.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }
  }
}

function toBuffer(png: PNG): Buffer {
  return PNG.sync.write(png);
}

describe("decodePng", () => {
  it("reads the pixel buffer of a valid PNG", () => {
    const decoded = decodePng(toBuffer(createPng(4, 3, WHITE)));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(decoded.data.length).toBe(4 * 3 * 4);
  });

  it("throws an ImageDecodeError for a buffer that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not an image"))).toThrow(ImageDecodeError);
  });
});

describe("normalizeImagePair", () => {
  it("leaves identical dimensions untouched", () => {
    const pair = normalizeImagePair(decodePng(toBuffer(createPng(8, 8, WHITE))), decodePng(toBuffer(createPng(8, 8, BLUE))));
    expect(pair.dimensionsChanged).toBe(false);
    expect(pair.width).toBe(8);
    expect(pair.current.data[0]).toBe(BLUE[0]);
  });

  it("pads the smaller image on white and flags the change", () => {
    const pair = normalizeImagePair(
      decodePng(toBuffer(createPng(10, 10, BLUE))),
      decodePng(toBuffer(createPng(10, 16, BLUE))),
    );
    expect(pair.dimensionsChanged).toBe(true);
    expect(pair.width).toBe(10);
    expect(pair.height).toBe(16);
    // Bottom-left pixel of the padded 10x16 baseline is white filler.
    const offset = (15 * 10 + 0) * 4;
    expect([pair.baseline.data[offset], pair.baseline.data[offset + 1], pair.baseline.data[offset + 2]]).toEqual([
      255, 255, 255,
    ]);
  });
});

describe("compareImages", () => {
  it("reports zero changed pixels for identical captures", () => {
    const image = toBuffer(createPng(64, 48, WHITE));
    const result = compareImages(image, image);
    expect(result.changedPixels).toBe(0);
    expect(result.changePercentage).toBe(0);
    expect(result.dimensionsChanged).toBe(false);
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
  });

  it("counts exactly the region that changed", () => {
    const baseline = createPng(100, 100, WHITE);
    const current = createPng(100, 100, WHITE);
    paintBlock(current, { x: 10, y: 20, width: 10, height: 10 }, BLUE);

    const result = compareImages(toBuffer(baseline), toBuffer(current));
    expect(result.changedPixels).toBe(100);
    expect(result.comparedPixels).toBe(10_000);
    expect(result.changePercentage).toBeCloseTo(1, 6);
  });

  it("returns a decodable diff image of the compared size", () => {
    const baseline = createPng(20, 20, WHITE);
    const current = createPng(20, 20, WHITE);
    paintBlock(current, { x: 0, y: 0, width: 5, height: 5 }, BLUE);

    const result = compareImages(toBuffer(baseline), toBuffer(current));
    const diff = decodePng(result.diffPng);
    expect(diff.width).toBe(20);
    expect(diff.height).toBe(20);
    // Highlighted pixels are painted in the diff colour, not left white.
    const highlighted = diff.data[0];
    expect(highlighted).toBeLessThan(255);
  });

  it("normalises mismatched dimensions instead of failing", () => {
    const baseline = createPng(100, 100, WHITE);
    const current = createPng(100, 120, WHITE);
    paintBlock(current, { x: 0, y: 100, width: 100, height: 20 }, BLUE);

    const result = compareImages(toBuffer(baseline), toBuffer(current));
    expect(result.dimensionsChanged).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(120);
    expect(result.comparedPixels).toBe(12_000);
    expect(result.baselineSize.height).toBe(100);
    expect(result.currentSize.height).toBe(120);
    expect(result.changePercentage).toBeCloseTo((2_000 / 12_000) * 100, 6);
  });
});
