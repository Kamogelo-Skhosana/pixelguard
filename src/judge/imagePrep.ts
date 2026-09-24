/**
 * Prepares screenshots for the vision judge.
 *
 * Full-page screenshots can be very tall (10,000px+). Vision APIs reject
 * huge images and shrink large ones, which blurs exactly the details the
 * judge needs. So before sending, the three images are:
 *
 *   1. cropped (full width) to the rows around the changed pixels, plus some
 *      context above and below (at least minHeight rows, so the layout
 *      around the change is visible), and
 *   2. scaled down only if the crop is still bigger than maxDimension.
 *
 * All three images get the same crop and scale, so they stay aligned.
 *
 * Ticket: P023
 */

import { PNG } from "pngjs";
import { loadPng, padImage } from "../diff/imageCompare.js";
import type { JudgeImages } from "./llmClient.js";

export interface PrepareOptions {
  /** Rows of context kept above and below the changed area (default: 250). */
  contextPx?: number;
  /** Longest allowed side of the images sent, in px (default: 3000). */
  maxDimension?: number;
  /**
   * Smallest crop height, so the judge always sees enough of the layout
   * around a change (default: 1000). Screenshots shorter than this are sent whole.
   */
  minHeight?: number;
}

/** Which part of the full page the judge images show, and at what scale. */
export interface JudgeView {
  /** First row of the full page shown (full-page pixels). */
  top: number;
  /** Rows of the full page shown (full-page pixels). */
  height: number;
  fullWidth: number;
  fullHeight: number;
  /** Size multiplier applied after cropping (1 = actual size). */
  scale: number;
  /** Size of the images actually sent. */
  imageWidth: number;
  imageHeight: number;
}

export interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Finds the box around the changed (pure red) pixels in a diff image.
 * Yellow anti-aliasing and light-blue masked pixels don't count.
 * Returns null if nothing changed.
 */
export function findChangedBounds(diff: PNG): Bounds | null {
  let top = -1;
  let bottom = -1;
  let left = diff.width;
  let right = -1;
  const d = diff.data;
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return top === -1 ? null : { top, bottom, left, right };
}

/** Copies rows [top, top + height) of image into a new PNG. */
export function cropRows(image: PNG, top: number, height: number): PNG {
  const out = new PNG({ width: image.width, height });
  PNG.bitblt(image, out, 0, top, image.width, height, 0, 0);
  return out;
}

/** Shrinks image by scale (0 < scale <= 1), averaging the pixels each output pixel covers. */
export function downscale(image: PNG, scale: number): PNG {
  if (scale >= 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const out = new PNG({ width, height });
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor(oy * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * yRatio));
    for (let ox = 0; ox < width; ox++) {
      const x0 = Math.floor(ox * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * xRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * image.width + x) * 4;
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
          a += image.data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * width + ox) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Works out the crop window and scale for a diff image. */
export function planView(diff: PNG, options: PrepareOptions = {}): JudgeView {
  const { contextPx = 250, maxDimension = 3000, minHeight = 1000 } = options;
  const bounds = findChangedBounds(diff);

  let top = 0;
  let bottom = diff.height; // exclusive
  if (bounds) {
    top = Math.max(0, bounds.top - contextPx);
    bottom = Math.min(diff.height, bounds.bottom + 1 + contextPx);

    // Grow a small crop evenly around the change up to minHeight, shifting
    // the window if it hits the top or bottom of the page.
    const shortBy = Math.min(minHeight, diff.height) - (bottom - top);
    if (shortBy > 0) {
      top = Math.max(0, top - Math.ceil(shortBy / 2));
      bottom = Math.min(diff.height, top + Math.min(minHeight, diff.height));
      top = Math.max(0, bottom - Math.min(minHeight, diff.height));
    }
  }
  const height = bottom - top;
  const scale = Math.min(1, maxDimension / diff.width, maxDimension / height);

  return {
    top,
    height,
    fullWidth: diff.width,
    fullHeight: diff.height,
    scale,
    imageWidth: Math.max(1, Math.round(diff.width * scale)),
    imageHeight: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Loads the baseline, current and diff PNGs and returns them as base64,
 * cropped and scaled identically, plus the view describing what they show.
 */
export async function prepareJudgeImages(
  paths: { baseline: string; current: string; diff: string },
  options: PrepareOptions = {}
): Promise<{ images: JudgeImages; view: JudgeView }> {
  const [baseline, current, diff] = await Promise.all([
    loadPng(paths.baseline),
    loadPng(paths.current),
    loadPng(paths.diff),
  ]);
  const view = planView(diff, options);

  const prepare = (image: PNG) => {
    // Pad to the diff's size (as the comparison did) so all three line up.
    const padded = padImage(image, diff.width, diff.height);
    const cropped =
      view.top === 0 && view.height === diff.height
        ? padded
        : cropRows(padded, view.top, view.height);
    return PNG.sync.write(downscale(cropped, view.scale)).toString("base64");
  };

  return {
    images: { baseline: prepare(baseline), current: prepare(current), diff: prepare(diff) },
    view,
  };
}
