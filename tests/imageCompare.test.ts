/**
 * Tests for the pixelmatch-based image comparison.
 *
 * Ticket: P012
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareImageFiles,
  compareImages,
  loadPng,
  padImage,
  savePng,
} from "../src/diff/imageCompare.js";

type RGB = [number, number, number];

/** Creates a solid-colour image, optionally with some pixels set to other colours. */
function makeImage(
  width: number,
  height: number,
  colour: RGB,
  pixels: { x: number; y: number; colour: RGB }[] = []
): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([...colour, 255], i);
  }
  for (const p of pixels) {
    png.data.set([...p.colour, 255], (p.y * width + p.x) * 4);
  }
  return png;
}

function pixelAt(png: PNG, x: number, y: number): number[] {
  const i = (png.width * y + x) * 4;
  return [...png.data.subarray(i, i + 4)];
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-compare-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("compareImages", () => {
  it("finds no differences between identical images", () => {
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 10, WHITE));
    expect(result.pixelDiffCount).toBe(0);
    expect(result.sizeChanged).toBe(false);
    expect([result.width, result.height]).toEqual([20, 10]);
  });

  it("counts changed pixels and marks them red in the diff image", () => {
    const changed = [
      { x: 5, y: 5, colour: BLACK },
      { x: 15, y: 2, colour: BLACK },
    ];
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 10, WHITE, changed));
    expect(result.pixelDiffCount).toBe(2);
    expect(pixelAt(result.diff, 5, 5)).toEqual([255, 0, 0, 255]);
    // Unchanged pixels are a faded copy of the baseline, not red.
    expect(pixelAt(result.diff, 0, 0)).not.toEqual([255, 0, 0, 255]);
  });

  it("ignores colour changes below the threshold", () => {
    const base = makeImage(10, 10, [200, 200, 200]);
    const slightlyDarker = makeImage(10, 10, [198, 198, 198]);
    expect(compareImages(base, slightlyDarker).pixelDiffCount).toBe(0);
    expect(compareImages(base, slightlyDarker, { threshold: 0 }).pixelDiffCount).toBe(100);
  });

  it("rejects a threshold outside 0-1", () => {
    const img = makeImage(2, 2, WHITE);
    expect(() => compareImages(img, img, { threshold: 1.5 })).toThrow(/between 0 and 1/);
  });

  it("handles images of different heights by counting the extra area as changed", () => {
    // Current page grew by 5 rows (a full-page screenshot got taller).
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 15, WHITE));
    expect(result.sizeChanged).toBe(true);
    expect([result.width, result.height]).toEqual([20, 15]);
    expect(result.baselineSize).toEqual({ width: 20, height: 10 });
    expect(result.currentSize).toEqual({ width: 20, height: 15 });
    expect(result.pixelDiffCount).toBe(20 * 5);
  });

  it("handles images of different widths too", () => {
    const result = compareImages(makeImage(12, 10, WHITE), makeImage(10, 10, WHITE));
    expect([result.width, result.height]).toEqual([12, 10]);
    expect(result.pixelDiffCount).toBe(2 * 10);
  });
});

describe("compareImages with a mask (P019)", () => {
  const changed = [
    { x: 2, y: 2, colour: BLACK },
    { x: 15, y: 8, colour: BLACK },
  ];

  it("doesn't count changes inside masked areas", () => {
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 10, WHITE, changed), {
      mask: [{ x: 0, y: 0, width: 5, height: 5 }],
    });
    expect(result.pixelDiffCount).toBe(1); // only the pixel at (15, 8)
  });

  it("tints masked areas light blue in the diff image", () => {
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 10, WHITE, changed), {
      mask: [{ x: 0, y: 0, width: 5, height: 5 }],
    });
    expect(pixelAt(result.diff, 2, 2)).toEqual([190, 215, 255, 255]);
    expect(pixelAt(result.diff, 15, 8)).toEqual([255, 0, 0, 255]);
  });

  it("clips masks that go past the image edge and skips ones fully outside", () => {
    const result = compareImages(makeImage(20, 10, WHITE), makeImage(20, 10, WHITE, changed), {
      mask: [
        { x: 12, y: 5, width: 100, height: 100 },
        { x: 500, y: 500, width: 10, height: 10 },
      ],
    });
    expect(result.pixelDiffCount).toBe(1); // (15, 8) is masked, (2, 2) is not
  });

  it("never modifies the images passed in", () => {
    const baseline = makeImage(4, 4, WHITE);
    const before = Buffer.from(baseline.data);
    compareImages(baseline, makeImage(4, 4, WHITE), {
      mask: [{ x: 0, y: 0, width: 4, height: 4 }],
    });
    expect(Buffer.compare(baseline.data, before)).toBe(0);
  });
});

describe("padImage", () => {
  it("returns the same image when no padding is needed", () => {
    const img = makeImage(4, 4, WHITE);
    expect(padImage(img, 4, 4)).toBe(img);
  });

  it("keeps the original pixels top-left and fills the rest", () => {
    const padded = padImage(makeImage(2, 2, BLACK), 3, 3);
    expect(pixelAt(padded, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(padded, 2, 2)).toEqual([255, 0, 255, 255]);
  });

  it("refuses to shrink an image", () => {
    expect(() => padImage(makeImage(4, 4, WHITE), 2, 2)).toThrow(/Cannot pad/);
  });
});

describe("file helpers", () => {
  it("compareImageFiles loads both PNGs and writes the diff image", async () => {
    const baseline = join(dir, "baseline.png");
    const current = join(dir, "current.png");
    const diffPath = join(dir, "out", "nested", "diff.png");
    await savePng(makeImage(8, 8, WHITE), baseline);
    await savePng(makeImage(8, 8, WHITE, [{ x: 1, y: 1, colour: BLACK }]), current);

    const result = await compareImageFiles(baseline, current, diffPath);
    expect(result.pixelDiffCount).toBe(1);

    const written = await loadPng(diffPath);
    expect([written.width, written.height]).toEqual([8, 8]);
    expect(pixelAt(written, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it("loadPng explains a missing file", async () => {
    await expect(loadPng(join(dir, "nope.png"))).rejects.toThrow(/Image not found/);
  });

  it("loadPng explains a file that isn't a PNG", async () => {
    const bad = join(dir, "bad.png");
    await writeFile(bad, "not an image");
    await expect(loadPng(bad)).rejects.toThrow(/Not a valid PNG/);
  });
});
