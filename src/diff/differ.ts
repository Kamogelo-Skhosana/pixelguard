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

export interface DiffImagesOptions extends Omit<CompareOptions, "mask"> {
  /** Regions to leave out of the comparison; recorded as ignoredRegions. */
  ignoredRegions?: DiffResult["ignoredRegions"];
  /** Regions expected to change; passed through to the result for the judge. */
  expectedChangeRegions?: DiffResult["expectedChangeRegions"];
}

export async function diffImages(
  baselinePath: string,
  currentPath: string,
  outputDiffPath: string,
  page: string,
  viewport: string,
  options: DiffImagesOptions = {}
): Promise<DiffResult> {
  const { ignoredRegions = [], expectedChangeRegions = [], ...compare } = options;
  const result = await compareImageFiles(baselinePath, currentPath, outputDiffPath, {
    ...compare,
    mask: ignoredRegions.map((r) => r.rect),
  });
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
    ...(ignoredRegions.length > 0 && { ignoredRegions }),
    ...(expectedChangeRegions.length > 0 && { expectedChangeRegions }),
  };
}
