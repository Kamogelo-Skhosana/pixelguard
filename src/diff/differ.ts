/**
 * Pixel-level image diffing using pixelmatch.
 *
 * Tickets: P012, P013
 */

import type { DiffResult } from "./models.js";

export async function diffImages(
  baselinePath: string,
  currentPath: string,
  outputDiffPath: string,
  page: string,
  viewport: string
): Promise<DiffResult> {
  // TODO (P012): load both PNGs (pngjs), run pixelmatch, write the
  // diff image to outputDiffPath.
  // TODO (P013): compute percentChanged from pixelDiffCount and
  // total pixel count, return a populated DiffResult.
  throw new Error("Not implemented");
}
