/**
 * Tests for the diff layer.
 *
 * Tickets: P012-P014
 */

import { readFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffImages } from "../src/diff/differ.js";
import { loadPng, savePng } from "../src/diff/imageCompare.js";
import { calculatePercentChanged, MIN_REPORTED_PERCENT } from "../src/diff/models.js";
import type { FixtureCase } from "../scripts/generate-diff-fixtures.js";

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
  // Pairs live in tests/fixtures/diff/ — regenerate with `npm run fixtures:diff`.
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");
  const cases = JSON.parse(readFileSync(join(fixtureDir, "cases.json"), "utf8")) as FixtureCase[];

  it("has sample pairs to test", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(cases.map((c) => [c.name + (c.options ? ` ${JSON.stringify(c.options)}` : ""), c]))(
    "%s",
    async (_label, c) => {
      const diffPath = join(dir, "fixtures", `${c.name}-${cases.indexOf(c)}.png`);
      const result = await diffImages(
        join(fixtureDir, c.name, "baseline.png"),
        join(fixtureDir, c.name, "current.png"),
        diffPath,
        c.name,
        "fixture",
        c.options
      );

      expect(result.changed).toBe(c.expected.changed);
      expect(result.sizeChanged).toBe(c.expected.sizeChanged);
      if (c.expected.pixelDiffCount !== undefined) {
        expect(result.pixelDiffCount).toBe(c.expected.pixelDiffCount);
      }
      if (c.expected.percentChanged !== undefined) {
        expect(result.percentChanged).toBe(c.expected.percentChanged);
      }

      // The diff image always matches the compared size.
      const diff = await loadPng(diffPath);
      expect(diff.width * diff.height).toBe(result.totalPixels);

      if (c.changedRegion) {
        // Every red (changed) pixel must be inside the region that actually changed.
        const r = c.changedRegion;
        let outside = 0;
        let inside = 0;
        for (let y = 0; y < diff.height; y++) {
          for (let x = 0; x < diff.width; x++) {
            const i = (y * diff.width + x) * 4;
            const red = diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0;
            if (!red) continue;
            const within = x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
            if (within) inside++;
            else outside++;
          }
        }
        expect(inside).toBeGreaterThan(0);
        expect(outside).toBe(0);
      }
    }
  );
});
