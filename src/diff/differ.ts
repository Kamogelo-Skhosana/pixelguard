/**
 * Pixel-level image diffing using pixelmatch.
 *
 * Tickets: P012, P013
 */

import type { DiffResult } from "./models.js";

export async function diffImages(
  _baselinePath: string,
  _currentPath: string,
  _outputDiffPath: string,
  _page: string,
  _viewport: string
): Promise<DiffResult> {
  // TODO (P012): load both PNGs (pngjs), run pixelmatch, write the
  // diff image to outputDiffPath.
  // TODO (P013): compute percentChanged from pixelDiffCount and
  // total pixel count, return a populated DiffResult.
  throw new Error("Not implemented");
}
