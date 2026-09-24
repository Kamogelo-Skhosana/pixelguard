/**
 * Tests for preparing screenshots for the judge (crop + scale).
 *
 * Ticket: P023
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { savePng } from "../src/diff/imageCompare.js";
import {
  cropRows,
  downscale,
  findChangedBounds,
  planView,
  prepareJudgeImages,
} from "../src/judge/imagePrep.js";

type RGBA = [number, number, number, number];

function image(width: number, height: number, colour: RGBA = [255, 255, 255, 255]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(colour, i);
  return png;
}

function paint(png: PNG, x: number, y: number, w: number, h: number, colour: RGBA): PNG {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) png.data.set(colour, (row * png.width + col) * 4);
  return png;
}

const RED: RGBA = [255, 0, 0, 255];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-prep-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findChangedBounds", () => {
  it("returns null when nothing is red", () => {
    const diff = paint(image(20, 20), 0, 0, 5, 5, [255, 255, 0, 255]); // yellow AA only
    paint(diff, 10, 10, 5, 5, [190, 215, 255, 255]); // light-blue mask
    expect(findChangedBounds(diff)).toBeNull();
  });

  it("finds the box around red pixels", () => {
    const diff = paint(paint(image(50, 100), 5, 20, 3, 2, RED), 30, 70, 1, 1, RED);
    expect(findChangedBounds(diff)).toEqual({ top: 20, bottom: 70, left: 5, right: 30 });
  });
});

describe("cropRows / downscale", () => {
  it("crops rows at full width", () => {
    const src = paint(image(10, 10), 0, 6, 10, 1, RED);
    const out = cropRows(src, 5, 3);
    expect([out.width, out.height]).toEqual([10, 3]);
    expect([...out.data.subarray(10 * 4, 10 * 4 + 4)]).toEqual(RED); // row 6 -> row 1
  });

  it("averages pixels when shrinking", () => {
    // 2x2 blocks: black + white columns average to grey
    const src = image(4, 4);
    paint(src, 0, 0, 1, 4, [0, 0, 0, 255]);
    paint(src, 2, 0, 1, 4, [0, 0, 0, 255]);
    const out = downscale(src, 0.5);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([...out.data.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
  });

  it("leaves images alone at scale 1", () => {
    const src = image(3, 3);
    expect(downscale(src, 1)).toBe(src);
  });
});

describe("planView", () => {
  it("keeps short screenshots whole and unscaled", () => {
    const view = planView(paint(image(1440, 900), 100, 100, 10, 10, RED));
    expect(view).toEqual({
      top: 0,
      height: 900,
      fullWidth: 1440,
      fullHeight: 900,
      scale: 1,
      imageWidth: 1440,
      imageHeight: 900,
    });
  });

  it("crops a tall page to the changed rows plus context", () => {
    const diff = paint(image(1440, 10000), 0, 5000, 100, 50, RED);
    const view = planView(diff, { contextPx: 250, minHeight: 0 });
    expect(view).toMatchObject({ top: 4750, height: 550, scale: 1, imageHeight: 550 });
  });

  it("grows a small crop evenly to minHeight so the layout is visible", () => {
    const diff = paint(image(1440, 10000), 0, 5000, 100, 50, RED);
    // 4750-5300 (550 rows) grows by 225 on each side to 1000 rows
    expect(planView(diff, { contextPx: 250 })).toMatchObject({ top: 4525, height: 1000 });
  });

  it("shifts the crop window when it hits the top or bottom of the page", () => {
    const nearTop = paint(image(100, 5000), 0, 10, 10, 10, RED);
    expect(planView(nearTop, { contextPx: 250 })).toMatchObject({ top: 0, height: 1000 });
    const nearBottom = paint(image(100, 5000), 0, 4980, 10, 10, RED);
    expect(planView(nearBottom, { contextPx: 250 })).toMatchObject({ top: 4000, height: 1000 });
  });

  it("clamps the context at the page edges", () => {
    const view = planView(paint(image(100, 1000), 0, 10, 10, 10, RED), {
      contextPx: 250,
      minHeight: 0,
    });
    expect(view).toMatchObject({ top: 0, height: 270 });
  });

  it("scales down when changes are spread over a very tall area", () => {
    const diff = paint(paint(image(1440, 12000), 0, 500, 10, 10, RED), 0, 11000, 10, 10, RED);
    const view = planView(diff, { contextPx: 0, maxDimension: 3000 });
    expect(view.height).toBe(10510);
    expect(view.scale).toBeCloseTo(3000 / 10510, 5);
    expect(view.imageHeight).toBe(3000);
  });

  it("uses the whole image when no red pixels are found", () => {
    expect(planView(image(100, 5000), { maxDimension: 1000 })).toMatchObject({
      top: 0,
      height: 5000,
      scale: 0.2,
    });
  });
});

describe("prepareJudgeImages", () => {
  it("crops and scales all three images identically and returns base64 PNGs", async () => {
    const paths = {
      baseline: join(dir, "b.png"),
      current: join(dir, "c.png"),
      diff: join(dir, "d.png"),
    };
    await savePng(image(400, 6000), paths.baseline);
    await savePng(image(400, 6200), paths.current); // page grew
    await savePng(paint(image(400, 6200), 0, 3000, 400, 20, RED), paths.diff);

    const { images, view } = await prepareJudgeImages(paths, { contextPx: 100 });
    expect(view).toMatchObject({ top: 2510, height: 1000, fullHeight: 6200, scale: 1 });
    for (const data of [images.baseline, images.current, images.diff]) {
      const png = PNG.sync.read(Buffer.from(data, "base64"));
      expect([png.width, png.height]).toEqual([400, 1000]);
    }
  });

  it("explains a missing screenshot", async () => {
    await expect(
      prepareJudgeImages({ baseline: join(dir, "nope.png"), current: "x", diff: "y" })
    ).rejects.toThrow(/Image not found/);
  });
});
