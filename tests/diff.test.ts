/**
 * Tests for the diff layer.
 *
 * Tickets: P012-P014
 */

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffImages } from "../src/diff/differ.js";
import { savePng } from "../src/diff/imageCompare.js";
import { calculatePercentChanged, MIN_REPORTED_PERCENT } from "../src/diff/models.js";

function solidImage(width: number, height: number, grey: number): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([grey, grey, grey, 255], i);
  return png;
}

/** Paints a filled rectangle onto an image. */
function paintRect(png: PNG, x: number, y: number, w: number, h: number, grey: number): PNG {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      png.data.set([grey, grey, grey, 255], (row * png.width + col) * 4);
    }
  }
  return png;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-diff-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("calculatePercentChanged (P013)", () => {
  it.each([
    [0, 100, 0],
    [1, 100, 1],
    [25, 200, 12.5],
    [100, 100, 100],
    [1, 3, 33.3333],
  ])("%i of %i pixels -> %f%%", (count, total, expected) => {
    expect(calculatePercentChanged(count, total)).toBe(expected);
  });

  it("never rounds a real change down to 0", () => {
    // 1 changed pixel in a 1440 x 20000 full-page screenshot
    expect(calculatePercentChanged(1, 1440 * 20000)).toBe(MIN_REPORTED_PERCENT);
  });

  it.each([
    [-1, 100, /non-negative/],
    [1, 0, /positive/],
    [101, 100, /exceeds/],
    [Number.NaN, 100, /non-negative/],
  ])("rejects count=%s total=%s", (count, total, error) => {
    expect(() => calculatePercentChanged(count, total)).toThrow(error);
  });
});

describe("diffImages (P013)", () => {
  it("returns a fully populated DiffResult and writes the diff image", async () => {
    const baseline = join(dir, "baseline", "desktop", "home.png");
    const current = join(dir, "current", "desktop", "home.png");
    const diffPath = join(dir, "diffs", "desktop", "home.png");
    await savePng(solidImage(100, 50, 255), baseline);
    // A 10 x 5 dark box appears: 50 of 5000 pixels = 1%
    await savePng(paintRect(solidImage(100, 50, 255), 10, 10, 10, 5, 0), current);

    const result = await diffImages(baseline, current, diffPath, "home", "desktop");

    expect(result).toEqual({
      page: "home",
      viewport: "desktop",
      pixelDiffCount: 50,
      totalPixels: 5000,
      percentChanged: 1,
      changed: true,
      sizeChanged: false,
      baselineSize: { width: 100, height: 50 },
      currentSize: { width: 100, height: 50 },
      diffImagePath: diffPath,
      baselineImagePath: baseline,
      currentImagePath: current,
    });
    await expect(access(diffPath)).resolves.toBeUndefined();
  });

  it("reports unchanged screenshots as 0% and changed: false", async () => {
    const a = join(dir, "same-a.png");
    const b = join(dir, "same-b.png");
    await savePng(solidImage(40, 40, 128), a);
    await savePng(solidImage(40, 40, 128), b);

    const result = await diffImages(a, b, join(dir, "same-diff.png"), "about", "mobile");
    expect(result.pixelDiffCount).toBe(0);
    expect(result.percentChanged).toBe(0);
    expect(result.changed).toBe(false);
  });

  it("uses the larger size as the total when the page height changed", async () => {
    const a = join(dir, "short.png");
    const b = join(dir, "tall.png");
    await savePng(solidImage(10, 10, 255), a);
    await savePng(solidImage(10, 20, 255), b);

    const result = await diffImages(a, b, join(dir, "height-diff.png"), "home", "mobile");
    expect(result.sizeChanged).toBe(true);
    expect(result.totalPixels).toBe(200);
    expect(result.pixelDiffCount).toBe(100);
    expect(result.percentChanged).toBe(50);
    expect(result.baselineSize).toEqual({ width: 10, height: 10 });
    expect(result.currentSize).toEqual({ width: 10, height: 20 });
  });

  it("passes compare options through (threshold)", async () => {
    const a = join(dir, "grey-a.png");
    const b = join(dir, "grey-b.png");
    await savePng(solidImage(10, 10, 200), a);
    await savePng(solidImage(10, 10, 198), b);

    const lenient = await diffImages(a, b, join(dir, "g1.png"), "p", "v");
    const strict = await diffImages(a, b, join(dir, "g2.png"), "p", "v", { threshold: 0 });
    expect(lenient.changed).toBe(false);
    expect(strict.percentChanged).toBe(100);
  });
});

describe("diff engine with sample image pairs (P014)", () => {
  it.todo("returns correct DiffResults for a set of known sample image pairs");
});
