/**
 * Baseline management — promoting a "current" capture to the new
 * baseline, and keeping a history of accepted baselines.
 *
 * Accepting (P044) copies a capture over the baseline tag, either whole or
 * just some pages. The new baseline is built in a temporary folder and
 * swapped in at the end, so a failure part-way never leaves a
 * half-replaced baseline.
 *
 * Replaced baselines are archived, not deleted, and can be reviewed or
 * restored — see baselineHistory.ts (P045).
 *
 * Tickets: P044, P045
 */

import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pageName } from "../capture/pages.js";
import { getBaselineHistory, recordNewVersion, versionDir } from "./baselineHistory.js";
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
  /** How many old baseline versions to keep archived (default 20) (P045). */
  keepVersions?: number;
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
  /** The baseline version this created (P045). */
  version: number;
}

/** Thrown when an accept is refused (bad input, failed screenshots...). Nothing is changed. */
export class AcceptError extends Error {
  /**
   * @param code machine-readable reason for API clients, e.g. "failed_screenshots"
   *   (the dashboard offers to accept just the screenshots that worked).
   */
  constructor(
    message: string,
    readonly code?: "failed_screenshots"
  ) {
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
  const now = options.now ?? new Date();
  const at = now.toISOString();

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
        `Re-capture, or use --force to accept only the screenshots that worked.`,
      "failed_screenshots"
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
    const previous = await readManifest(options.outputDir, toTag).catch(() => null);
    const hadBaseline = await swapIn(tempDir, toDir, oldDir);

    // Archive the old baseline instead of deleting it (P045).
    const version = await recordNewVersion({
      outputDir: options.outputDir,
      tag: toTag,
      previousDir: hadBaseline ? oldDir : null,
      previousCreatedAt: previous?.promotedFrom?.at ?? previous?.capturedAt,
      source: {
        type: "accept",
        fromTag,
        pages: wholeCapture ? null : accepted.map((p) => p.name),
        screenshots,
      },
      at: now,
      keep: options.keepVersions,
    });

    return {
      fromTag,
      toTag,
      pages: accepted.map((p) => p.name),
      screenshots,
      wholeCapture,
      version: version.version,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true }); // only left if archiving failed
  }
}

/**
 * Moves the current baseline (if any) aside to oldDir and the new one from
 * tempDir into place, putting the old one back if that fails.
 * Returns whether there was an old baseline.
 */
async function swapIn(tempDir: string, toDir: string, oldDir: string): Promise<boolean> {
  const hadBaseline = await rename(toDir, oldDir).then(
    () => true,
    () => false
  );
  try {
    await rename(tempDir, toDir);
  } catch (err) {
    if (hadBaseline) await rename(oldDir, toDir);
    throw err;
  }
  return hadBaseline;
}

export interface RestoreOptions {
  outputDir: string;
  tag?: string;
  /** The archived version to bring back. */
  version: number;
  now?: Date;
  keepVersions?: number;
}

/**
 * Makes an archived baseline version the live baseline again. The baseline
 * being replaced is archived as usual, and the restore is recorded as a new
 * version, so a restore can itself be undone.
 */
export async function restoreBaseline(options: RestoreOptions): Promise<{ version: number }> {
  const tag = validateTag(options.tag ?? "baseline");
  const history = await getBaselineHistory(options.outputDir, tag);
  const target = history.versions.find((v) => v.version === options.version);
  if (!target) {
    throw new AcceptError(`There's no version ${options.version} of "${tag}".`);
  }
  if (target.current) {
    throw new AcceptError(`Version ${options.version} is already the current "${tag}".`);
  }
  if (!target.archived) {
    throw new AcceptError(
      `Version ${options.version} of "${tag}" is no longer archived (only the newest versions are kept).`
    );
  }

  const now = options.now ?? new Date();
  const stamp = `${process.pid}-${Date.now()}`;
  const tempDir = join(options.outputDir, `.tmp-restore-${tag}-${stamp}`);
  const oldDir = join(options.outputDir, `.old-${tag}-${stamp}`);
  try {
    await cp(versionDir(options.outputDir, tag, options.version), tempDir, { recursive: true });
    const manifest = await readManifest(options.outputDir, tag).catch(() => null);
    const hadBaseline = await swapIn(tempDir, tagDir(options.outputDir, tag), oldDir);
    const version = await recordNewVersion({
      outputDir: options.outputDir,
      tag,
      previousDir: hadBaseline ? oldDir : null,
      previousCreatedAt: manifest?.capturedAt,
      source: { type: "restore", fromVersion: options.version },
      at: now,
      keep: options.keepVersions,
    });
    return { version: version.version };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
}

export { getBaselineHistory } from "./baselineHistory.js";
