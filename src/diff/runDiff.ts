/**
 * Diffs a whole baseline capture against a whole current capture.
 *
 * Pairs screenshots using each tag's manifest.json (P010) and runs
 * diffImages() on every page/viewport captured successfully in both.
 * Diff images go to <diffDir>/<baseline>-vs-<current>/<viewport>/<page>.png.
 *
 * Ticket: P015
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, tagDir, validateTag } from "../capture/storage.js";
import { diffImages } from "./differ.js";
import type { CompareOptions } from "./imageCompare.js";
import type { DiffResult } from "./models.js";

export interface DiffTagsOptions {
  outputDir: string;
  diffDir: string;
  baselineTag: string;
  currentTag: string;
  compare?: CompareOptions;
  /** Called after each page/viewport is diffed, e.g. to print progress. */
  onResult?: (result: DiffResult) => void;
}

/** A page/viewport that couldn't be compared, and why. */
export interface SkippedDiff {
  page: string;
  viewport: string;
  reason: string;
}

export interface DiffTagsResult {
  /** Folder the diff images were written to. */
  dir: string;
  targetUrl: string;
  results: DiffResult[];
  skipped: SkippedDiff[];
}

type ShotStatus = { ok: true; file: string } | { ok: false; error: string };

export async function diffTags(options: DiffTagsOptions): Promise<DiffTagsResult> {
  const { outputDir, diffDir, compare } = options;
  const baselineTag = validateTag(options.baselineTag);
  const currentTag = validateTag(options.currentTag);
  if (baselineTag === currentTag) {
    throw new Error(`Baseline and current tags are the same ("${baselineTag}")`);
  }

  const [baseline, current] = await Promise.all([
    readManifest(outputDir, baselineTag),
    readManifest(outputDir, currentTag),
  ]);

  // Index each capture as page name -> viewport -> screenshot status.
  const index = (manifest: typeof baseline) => {
    const map = new Map<string, Map<string, ShotStatus>>();
    for (const page of manifest.pages) {
      const shots = new Map<string, ShotStatus>();
      for (const s of page.screenshots) {
        shots.set(s.viewport, s.ok ? { ok: true, file: s.file } : { ok: false, error: s.error });
      }
      map.set(page.name, shots);
    }
    return map;
  };
  const baseIndex = index(baseline);
  const currIndex = index(current);

  const dir = join(diffDir, `${baselineTag}-vs-${currentTag}`);
  await rm(dir, { recursive: true, force: true }); // don't mix in diffs from an older run

  const results: DiffResult[] = [];
  const skipped: SkippedDiff[] = [];

  // Walk pages in baseline order, then any pages that only exist in current.
  const pageNames = [...new Set([...baseIndex.keys(), ...currIndex.keys()])];
  for (const page of pageNames) {
    const baseShots = baseIndex.get(page);
    const currShots = currIndex.get(page);
    const viewports = [...new Set([...(baseShots?.keys() ?? []), ...(currShots?.keys() ?? [])])];

    for (const viewport of viewports) {
      const b = baseShots?.get(viewport);
      const c = currShots?.get(viewport);

      let reason: string | undefined;
      if (!b) reason = `not in "${baselineTag}" (new page or viewport?)`;
      else if (!b.ok) reason = `failed in "${baselineTag}": ${b.error}`;
      else if (!c) reason = `not in "${currentTag}" (removed page or viewport?)`;
      else if (!c.ok) reason = `failed in "${currentTag}": ${c.error}`;

      if (reason || !b?.ok || !c?.ok) {
        skipped.push({ page, viewport, reason: reason ?? "unknown" });
        continue;
      }

      const result = await diffImages(
        join(tagDir(outputDir, baselineTag), b.file),
        join(tagDir(outputDir, currentTag), c.file),
        join(dir, viewport, `${page}.png`),
        page,
        viewport,
        compare
      );
      results.push(result);
      options.onResult?.(result);
    }
  }

  return { dir, targetUrl: current.baseUrl, results, skipped };
}
