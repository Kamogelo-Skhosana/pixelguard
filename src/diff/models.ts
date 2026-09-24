/**
 * Internal DiffResult data model — the normalized shape every pixel
 * diff gets represented as before it reaches the judge layer.
 *
 * Ticket: P013
 */

export type Verdict = "Real Bug" | "Acceptable Change" | "Uncertain";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  /** Page name, e.g. "home" (see pageName() in capture.ts). */
  page: string;
  /** Viewport name, e.g. "desktop". */
  viewport: string;

  /** Number of pixels that differ between baseline and current. */
  pixelDiffCount: number;
  /** Pixels compared: width x height of the (padded) comparison area. */
  totalPixels: number;
  /**
   * pixelDiffCount as a percentage of totalPixels (0-100), rounded to 4
   * decimal places. Never rounds a real change down to 0.
   */
  percentChanged: number;
  /** True when any pixel differs. */
  changed: boolean;

  /** True when the baseline and current screenshots have different dimensions. */
  sizeChanged: boolean;
  baselineSize: ImageSize;
  currentSize: ImageSize;

  diffImagePath: string;
  baselineImagePath: string;
  currentImagePath: string;

  /** Known dynamic regions left out of the comparison (handling "ignore"). */
  ignoredRegions?: { label: string; rect: ImageRect }[];
  /** Known dynamic regions expected to change (handling "inform"), for the judge. */
  expectedChangeRegions?: { label: string; kind: string; rect: ImageRect }[];

  // Populated later by the judge layer (Phase 2) — see P024
  verdict?: Verdict;
  confidence?: number;
  explanation?: string;
}

/** Smallest percentage reported for a real change, so it never shows as 0%. */
export const MIN_REPORTED_PERCENT = 0.0001;

/**
 * Converts a changed-pixel count into a percentage of the total (0-100),
 * rounded to 4 decimal places. Any change above zero reports at least
 * MIN_REPORTED_PERCENT, so a handful of changed pixels on a huge
 * full-page screenshot is never hidden as "0%".
 */
export function calculatePercentChanged(pixelDiffCount: number, totalPixels: number): number {
  if (!Number.isFinite(pixelDiffCount) || pixelDiffCount < 0) {
    throw new Error(`pixelDiffCount must be a non-negative number (got ${pixelDiffCount})`);
  }
  if (!Number.isFinite(totalPixels) || totalPixels <= 0) {
    throw new Error(`totalPixels must be a positive number (got ${totalPixels})`);
  }
  if (pixelDiffCount > totalPixels) {
    throw new Error(`pixelDiffCount (${pixelDiffCount}) exceeds totalPixels (${totalPixels})`);
  }
  if (pixelDiffCount === 0) return 0;

  const percent = Math.round((pixelDiffCount / totalPixels) * 100 * 10_000) / 10_000;
  return Math.max(percent, MIN_REPORTED_PERCENT);
}
