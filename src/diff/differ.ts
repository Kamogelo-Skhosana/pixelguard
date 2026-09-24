/**
 * Pixel-level image diffing using pixelmatch.
 *
 * Compares a baseline and current screenshot of one page/viewport, writes
 * a diff image, and returns the result as a DiffResult.
 *
 * Tickets: P012, P013
 */

import { compareImageFiles, type CompareOptions } from "./imageCompare.js";
import { calculatePercentChanged, type DiffResult } from "./models.js";

export async function diffImages(
  baselinePath: string,
  currentPath: string,
  outputDiffPath: string,
  page: string,
  viewport: string,
  options: CompareOptions = {}
): Promise<DiffResult> {
  const result = await compareImageFiles(baselinePath, currentPath, outputDiffPath, options);
  const totalPixels = result.width * result.height;

  return {
    page,
    viewport,
    pixelDiffCount: result.pixelDiffCount,
    totalPixels,
    percentChanged: calculatePercentChanged(result.pixelDiffCount, totalPixels),
    changed: result.pixelDiffCount > 0,
    sizeChanged: result.sizeChanged,
    baselineSize: result.baselineSize,
    currentSize: result.currentSize,
    diffImagePath: outputDiffPath,
    baselineImagePath: baselinePath,
    currentImagePath: currentPath,
  };
}
