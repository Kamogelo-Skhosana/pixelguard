/**
 * Diffs a whole baseline capture against a whole current capture.
 *
 * Pairs screenshots using each tag's manifest.json (P010) and runs
 * diffImages() on every page/viewport captured successfully in both.
 * Diff images go to <diffDir>/<baseline>-vs-<current>/<viewport>/<page>.png.
 *
 * Known dynamic regions (P019): the regions config decides which regions
 * apply; rect regions are used as-is, and selector regions use the boxes
 * measured at capture time (from both manifests, so an element that moved
 * is covered in both positions). "ignore" regions are masked out of the
 * diff; "inform" regions are passed along for the judge.
 *
 * Tickets: P015, P019
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, tagDir, validateTag } from "../capture/storage.js";
import { diffImages } from "./differ.js";
import type { CompareOptions } from "./imageCompare.js";
import type { DiffResult } from "./models.js";
import {
  regionMatches,
  type DynamicRegion,
  type RegionRect,
  type ResolvedRegion,
} from "../judge/context.js";

export interface DiffTagsOptions {
  outputDir: string;
  diffDir: string;
  baselineTag: string;
  currentTag: string;
  compare?: CompareOptions;
  /** Known dynamic regions from the regions file (all pages). */
  regions?: DynamicRegion[];
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
  /** Problems that didn't stop the diff, e.g. regions that were never measured. */
  warnings: string[];
}

type ShotStatus =
  { ok: true; file: string; regions: ResolvedRegion[] } | { ok: false; error: string };

type RegionBox = { label: string; kind: string; rect: RegionRect };

/**
 * Works out the boxes for every configured region that applies to one
 * page/viewport, split by handling. Returns labels of selector regions
 * that weren't measured in either capture.
 */
function resolveRegions(
  regions: DynamicRegion[],
  page: string,
  viewport: string,
  measured: ResolvedRegion[]
): { ignore: RegionBox[]; inform: RegionBox[]; unmeasured: string[] } {
  const ignore: RegionBox[] = [];
  const inform: RegionBox[] = [];
  const unmeasured: string[] = [];

  for (const region of regions) {
    if (!regionMatches(region, page, viewport)) continue;
    let rects: RegionRect[];
    if (region.rect) {
      rects = [region.rect];
    } else {
      const found = measured.filter(
        (m) => m.selector === region.selector && m.label === region.label
      );
      if (found.length === 0) {
        unmeasured.push(region.label);
        continue;
      }
      // Same box in both captures (element didn't move) -> keep it once.
      const unique = new Map(
        found.flatMap((m) => m.rects).map((r) => [`${r.x},${r.y},${r.width},${r.height}`, r])
      );
      rects = [...unique.values()];
    }
    const boxes = rects.map((rect) => ({ label: region.label, kind: region.kind, rect }));
    (region.handling === "ignore" ? ignore : inform).push(...boxes);
  }
  return { ignore, inform, unmeasured };
}

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
        shots.set(
          s.viewport,
          s.ok
            ? { ok: true, file: s.file, regions: s.regions ?? [] }
            : { ok: false, error: s.error }
        );
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
  const warnings: string[] = [];

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

      const regions = resolveRegions(options.regions ?? [], page, viewport, [
        ...b.regions,
        ...c.regions,
      ]);
      for (const label of regions.unmeasured) {
        warnings.push(
          `Region "${label}" on ${page} / ${viewport} wasn't measured when these captures were taken — re-capture to apply it.`
        );
      }

      const result = await diffImages(
        join(tagDir(outputDir, baselineTag), b.file),
        join(tagDir(outputDir, currentTag), c.file),
        join(dir, viewport, `${page}.png`),
        page,
        viewport,
        {
          ...compare,
          ignoredRegions: regions.ignore.map(({ label, rect }) => ({ label, rect })),
          expectedChangeRegions: regions.inform,
        }
      );
      results.push(result);
      options.onResult?.(result);
    }
  }

  return { dir, targetUrl: current.baseUrl, results, skipped, warnings };
}
