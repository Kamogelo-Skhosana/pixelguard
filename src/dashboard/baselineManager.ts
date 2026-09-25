/**
 * Baseline management — promoting a "current" capture to the new
 * baseline, and keeping a history of accepted baselines.
 *
 * Accepting (P044) copies a capture over the baseline tag, either whole or
 * just some pages. The new baseline is built in a temporary folder and
 * swapped in at the end, so a failure part-way never leaves a
 * half-replaced baseline.
 *
 * Tickets: P044, P045
 */

import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pageName } from "../capture/pages.js";
import {
  readManifest,
  tagDir,
  validateTag,
  writeManifest,
  type CaptureManifest,
  type ManifestPage,
} from "../capture/storage.js";

export interface AcceptOptions {
  /** Root screenshots folder (Settings.outputDir). */
  outputDir: string;
  /** Capture to promote, e.g. "current". */
  fromTag: string;
  /** Tag to replace (default: "baseline"). */
  toTag?: string;
  /**
   * Only accept these pages (paths like "/pricing" or names like "pricing");
   * the rest of the baseline is kept. Default: the whole capture.
   */
  pages?: string[];
  /** Accept even if some screenshots in the capture failed (they're left out). */
  force?: boolean;
  /** When the promotion happened (default: now). */
  now?: Date;
}

export interface AcceptResult {
  fromTag: string;
  toTag: string;
  /** Names of the pages that were accepted. */
  pages: string[];
  /** Screenshots copied into the baseline. */
  screenshots: number;
  /** True when the whole baseline was replaced, false for a page-by-page accept. */
  wholeCapture: boolean;
}

/** Thrown when an accept is refused (bad input, failed screenshots...). Nothing is changed. */
export class AcceptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptError";
  }
}

function failedShots(page: ManifestPage): string[] {
  return page.screenshots.filter((s) => !s.ok).map((s) => `${page.page} / ${s.viewport}`);
}

/** Copies the page's successful screenshot files from one tag folder to another. */
async function copyPageFiles(page: ManifestPage, fromDir: string, toDir: string): Promise<number> {
  let copied = 0;
  for (const shot of page.screenshots) {
    if (!shot.ok) continue;
    await mkdir(join(toDir, shot.viewport), { recursive: true });
    await cp(join(fromDir, shot.file), join(toDir, shot.file));
    copied++;
  }
  return copied;
}

/** Keeps only the successful screenshots of a page (for forced accepts). */
function okOnly(page: ManifestPage): ManifestPage {
  return { ...page, screenshots: page.screenshots.filter((s) => s.ok) };
}

/**
 * Promotes a capture to be the new baseline (whole or selected pages).
 * Throws AcceptError without changing anything if the accept isn't safe.
 */
export async function acceptAsBaseline(options: AcceptOptions): Promise<AcceptResult> {
  const fromTag = validateTag(options.fromTag);
  const toTag = validateTag(options.toTag ?? "baseline");
  if (fromTag === toTag) {
    throw new AcceptError(`Can't accept "${fromTag}" as itself — choose a different tag.`);
  }

  const source = await readManifest(options.outputDir, fromTag).catch(() => {
    throw new AcceptError(
      `No capture found for tag "${fromTag}". Run: pixelguard capture --tag ${fromTag}`
    );
  });
  const fromDir = tagDir(options.outputDir, fromTag);
  const toDir = tagDir(options.outputDir, toTag);
  const at = (options.now ?? new Date()).toISOString();

  // Which pages to accept.
  let chosen: ManifestPage[];
  if (options.pages && options.pages.length > 0) {
    const wanted = [...new Set(options.pages.map(pageName))];
    const unknown = wanted.filter((name) => !source.pages.some((p) => p.name === name));
    if (unknown.length > 0) {
      throw new AcceptError(
        `Page(s) not in "${fromTag}": ${unknown.join(", ")}. Available: ${source.pages.map((p) => p.name).join(", ")}`
      );
    }
    chosen = source.pages.filter((p) => wanted.includes(p.name));
  } else {
    chosen = source.pages;
  }

  const failures = chosen.flatMap(failedShots);
  if (failures.length > 0 && !options.force) {
    throw new AcceptError(
      `Not accepting "${fromTag}": ${failures.length} screenshot(s) failed (${failures.join(", ")}). ` +
        `Re-capture, or use --force to accept only the screenshots that worked.`
    );
  }
  const accepted = chosen.map(okOnly).filter((p) => p.screenshots.length > 0);
  if (accepted.length === 0) {
    throw new AcceptError(`Nothing to accept: every chosen screenshot in "${fromTag}" failed.`);
  }

  const wholeCapture = !options.pages || options.pages.length === 0;
  let base: CaptureManifest | undefined;
  if (!wholeCapture) {
    base = await readManifest(options.outputDir, toTag).catch(() => {
      throw new AcceptError(
        `There's no "${toTag}" capture to update page by page yet — accept the whole capture first.`
      );
    });
  }

  // Build the new baseline in a temp folder, then swap it in.
  const stamp = `${process.pid}-${Date.now()}`;
  const tempDir = join(options.outputDir, `.tmp-accept-${toTag}-${stamp}`);
  const oldDir = join(options.outputDir, `.old-${toTag}-${stamp}`);
  try {
    let manifest: CaptureManifest;
    let screenshots = 0;

    if (wholeCapture) {
      await mkdir(tempDir, { recursive: true });
      for (const page of accepted) screenshots += await copyPageFiles(page, fromDir, tempDir);
      manifest = {
        ...source,
        tag: toTag,
        pages: accepted,
        promotedFrom: { tag: fromTag, at },
      };
    } else {
      // Start from the existing baseline and replace or add the chosen pages.
      await cp(toDir, tempDir, { recursive: true });
      const pages = [...base!.pages];
      for (const page of accepted) {
        // Drop the page's old files first, so viewports no longer captured don't linger.
        const old = pages.find((p) => p.name === page.name);
        for (const shot of old?.screenshots ?? []) {
          if (shot.ok) await rm(join(tempDir, shot.file), { force: true });
        }
        screenshots += await copyPageFiles(page, fromDir, tempDir);
        const index = pages.findIndex((p) => p.name === page.name);
        if (index >= 0) pages[index] = page;
        else pages.push(page);
      }
      manifest = {
        ...base!,
        pages,
        promotedFrom: { tag: fromTag, at, pages: accepted.map((p) => p.name) },
      };
    }

    await writeManifest(tempDir, manifest);
    // Swap: old baseline aside, new one in, then remove the old one.
    const hadBaseline = await rename(toDir, oldDir).then(
      () => true,
      () => false
    );
    try {
      await rename(tempDir, toDir);
    } catch (err) {
      if (hadBaseline) await rename(oldDir, toDir); // put the old baseline back
      throw err;
    }
    await rm(oldDir, { recursive: true, force: true });

    return {
      fromTag,
      toTag,
      pages: accepted.map((p) => p.name),
      screenshots,
      wholeCapture,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function getBaselineHistory(): Promise<unknown[]> {
  // TODO (P045): return a list of past baseline promotions with dates.
  throw new Error("Not implemented");
}
