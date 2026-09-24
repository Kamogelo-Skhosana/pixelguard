/**
 * Screenshot storage convention.
 *
 * Every capture run is saved under a tag (e.g. "baseline", "current"):
 *
 *   <outputDir>/<tag>/<viewport>/<page>.png
 *   <outputDir>/<tag>/manifest.json
 *
 * The manifest records what was captured, when, and which screenshots
 * failed, so the diff layer can pair baseline/current files reliably.
 *
 * Ticket: P010
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = "manifest.json";

/** Tags become folder names, so keep them simple and safe. */
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,49}$/i;

/** Throws if tag can't be used as a folder name (e.g. "", "..", "a/b"). */
export function validateTag(tag: string): string {
  if (!TAG_PATTERN.test(tag) || tag.includes("..")) {
    throw new Error(
      `Invalid tag "${tag}". Use 1-50 letters, numbers, dots, dashes or underscores ` +
        `(e.g. baseline, current, release-1.2).`
    );
  }
  return tag;
}

export function tagDir(outputDir: string, tag: string): string {
  return join(outputDir, validateTag(tag));
}

export function screenshotPath(
  outputDir: string,
  tag: string,
  viewport: string,
  page: string
): string {
  return join(tagDir(outputDir, tag), viewport, `${page}.png`);
}

export type ManifestScreenshot =
  | { viewport: string; ok: true; file: string; width: number; height: number }
  | { viewport: string; ok: false; error: string };

export interface ManifestPage {
  page: string;
  name: string;
  url: string;
  screenshots: ManifestScreenshot[];
}

export interface CaptureManifest {
  tag: string;
  capturedAt: string;
  baseUrl: string;
  viewports: { name: string; width: number; height: number }[];
  pages: ManifestPage[];
}

export async function writeManifest(dir: string, manifest: CaptureManifest): Promise<void> {
  await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Reads the manifest for a tag. Throws a clear error if the tag hasn't been captured. */
export async function readManifest(outputDir: string, tag: string): Promise<CaptureManifest> {
  const path = join(tagDir(outputDir, tag), MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No capture found for tag "${tag}" in ${outputDir}. ` + `Run: pixelguard capture --tag ${tag}`
    );
  }
  return JSON.parse(raw) as CaptureManifest;
}

/** Lists tags that have a completed capture (a folder containing a manifest). */
export async function listTags(outputDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tags: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TAG_PATTERN.test(entry.name)) continue;
    try {
      await readFile(join(outputDir, entry.name, MANIFEST_FILE));
      tags.push(entry.name);
    } catch {
      // Not a completed capture — skip.
    }
  }
  return tags.sort();
}
