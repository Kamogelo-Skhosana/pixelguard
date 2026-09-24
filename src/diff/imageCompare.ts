/**
 * Pixel-level image comparison using pixelmatch.
 *
 * Handles loading/saving PNGs and comparing two screenshots, including
 * screenshots of different sizes (common with full-page captures, where
 * a change can make the page taller or shorter).
 *
 * Ticket: P012
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface CompareOptions {
  /**
   * How different two pixels' colours must be to count as changed, from 0 to 1.
   * Lower is stricter (default: 0.1, pixelmatch's default).
   */
  threshold?: number;
  /**
   * Count anti-aliased edge pixels as changes too (default: false, so tiny
   * font-smoothing differences are ignored).
   */
  includeAntiAliasing?: boolean;
  /**
   * Areas to leave out of the comparison (known dynamic regions with
   * handling "ignore"). They never count as changed, and are tinted blue
   * in the diff image so it's clear they were skipped.
   */
  mask?: MaskRect[];
}

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareResult {
  /** Diff image: changed pixels in red over a faded copy of the baseline. */
  diff: PNG;
  /** Number of pixels that differ (including any area only one image covers). */
  pixelDiffCount: number;
  /** Size of the compared area: the larger of the two images in each direction. */
  width: number;
  height: number;
  baselineSize: { width: number; height: number };
  currentSize: { width: number; height: number };
  /** True when the two images had different dimensions. */
  sizeChanged: boolean;
}

/**
 * Colour used to fill the area one image doesn't cover when sizes differ.
 * Opaque magenta, so it shows up as a difference against almost any real content.
 */
const PAD_COLOUR = [255, 0, 255, 255] as const;

/** Tint for masked (ignored) areas in the diff image: light blue. */
const MASK_TINT = [190, 215, 255, 255] as const;

/** Clips a rect to the image, returning null if nothing is left. */
function clip(rect: MaskRect, width: number, height: number): MaskRect | null {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Sets every pixel inside the rects to colour (mutates image). */
function fillRects(image: PNG, rects: MaskRect[], colour: readonly number[]): void {
  for (const rect of rects) {
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      for (let col = rect.x; col < rect.x + rect.width; col++) {
        image.data.set(colour, (row * image.width + col) * 4);
      }
    }
  }
}

/** Returns a copy of image (so masking never modifies the caller's image). */
function clone(image: PNG): PNG {
  const copy = new PNG({ width: image.width, height: image.height });
  image.data.copy(copy.data);
  return copy;
}

/** Reads a PNG file, with a clear error if it's missing or not a valid PNG. */
export async function loadPng(path: string): Promise<PNG> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    throw new Error(`Image not found: ${path}`);
  }
  try {
    return PNG.sync.read(data);
  } catch (err) {
    throw new Error(`Not a valid PNG: ${path} (${(err as Error).message})`);
  }
}

/** Writes a PNG file, creating parent folders as needed. */
export async function savePng(png: PNG, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(png));
}

/**
 * Returns image placed at the top-left of a width x height canvas filled
 * with PAD_COLOUR. Returns the image unchanged if it's already that size.
 */
export function padImage(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;
  if (image.width > width || image.height > height) {
    throw new Error(`Cannot pad a ${image.width}x${image.height} image down to ${width}x${height}`);
  }

  const padded = new PNG({ width, height });
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = PAD_COLOUR[0];
    padded.data[i + 1] = PAD_COLOUR[1];
    padded.data[i + 2] = PAD_COLOUR[2];
    padded.data[i + 3] = PAD_COLOUR[3];
  }
  PNG.bitblt(image, padded, 0, 0, image.width, image.height, 0, 0);
  return padded;
}

/** Compares two images pixel by pixel. Images of different sizes are padded first. */
export function compareImages(
  baseline: PNG,
  current: PNG,
  options: CompareOptions = {}
): CompareResult {
  const { threshold = 0.1, includeAntiAliasing = false } = options;
  if (threshold < 0 || threshold > 1) {
    throw new Error(`threshold must be between 0 and 1 (got ${threshold})`);
  }

  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  let a = padImage(baseline, width, height);
  let b = padImage(current, width, height);

  const mask = (options.mask ?? [])
    .map((r) => clip(r, width, height))
    .filter((r): r is MaskRect => r !== null);
  if (mask.length > 0) {
    // Paint masked areas identically in both images so they can't differ.
    a = a === baseline ? clone(a) : a;
    b = b === current ? clone(b) : b;
    fillRects(a, mask, [0, 0, 0, 255]);
    fillRects(b, mask, [0, 0, 0, 255]);
  }

  const diff = new PNG({ width, height });

  const pixelDiffCount = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA: includeAntiAliasing,
    alpha: 0.1,
    diffColor: [255, 0, 0],
  });
  fillRects(diff, mask, MASK_TINT);

  return {
    diff,
    pixelDiffCount,
    width,
    height,
    baselineSize: { width: baseline.width, height: baseline.height },
    currentSize: { width: current.width, height: current.height },
    sizeChanged: baseline.width !== current.width || baseline.height !== current.height,
  };
}

/**
 * Loads two PNG files, compares them, and writes the diff image to
 * outputDiffPath. Returns the comparison result.
 */
export async function compareImageFiles(
  baselinePath: string,
  currentPath: string,
  outputDiffPath: string,
  options: CompareOptions = {}
): Promise<CompareResult> {
  const [baseline, current] = await Promise.all([loadPng(baselinePath), loadPng(currentPath)]);
  const result = compareImages(baseline, current, options);
  await savePng(result.diff, outputDiffPath);
  return result;
}
