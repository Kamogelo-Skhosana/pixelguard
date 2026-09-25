/**
 * Baseline versioning and history (P045).
 *
 * Every time a baseline is replaced (accept or restore), the old one is
 * archived instead of deleted:
 *
 *   <outputDir>/_history/<tag>/history.json   list of versions
 *   <outputDir>/_history/<tag>/v1/            the baseline as it was at version 1
 *   <outputDir>/_history/<tag>/v2/            ...
 *
 * Version 1 is the first baseline (captured, not accepted). Each accept or
 * restore creates the next version. The live baseline is always the latest
 * version and lives in <outputDir>/<tag>/ as usual; older versions can be
 * reviewed or restored. Only the newest `keep` archives are kept.
 *
 * The "_history" folder name can't be a tag (tags start with a letter or
 * digit), so it never shows up as a capture.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, validateTag, type CaptureManifest } from "../capture/storage.js";

export const HISTORY_DIR = "_history";
export const DEFAULT_KEEP_VERSIONS = 20;

export interface BaselineVersion {
  version: number;
  /** When this version became the baseline. */
  createdAt: string;
  /** How it was made. */
  source:
    | { type: "accept"; fromTag: string; pages: string[] | null; screenshots: number }
    | { type: "restore"; fromVersion: number };
}

export interface HistoryFile {
  tag: string;
  versions: BaselineVersion[];
}

export interface BaselineHistory {
  tag: string;
  /** The version that is the live baseline now (null if there's no history yet). */
  currentVersion: number | null;
  /** Newest first. `archived` says whether that version's files can still be reviewed/restored. */
  versions: (BaselineVersion & { current: boolean; archived: boolean })[];
}

export const historyDir = (outputDir: string, tag: string) =>
  join(outputDir, HISTORY_DIR, validateTag(tag));
export const versionDir = (outputDir: string, tag: string, version: number) =>
  join(historyDir(outputDir, tag), `v${version}`);

export async function readHistoryFile(outputDir: string, tag: string): Promise<HistoryFile> {
  try {
    const raw = await readFile(join(historyDir(outputDir, tag), "history.json"), "utf8");
    const data = JSON.parse(raw) as HistoryFile;
    if (!Array.isArray(data.versions)) throw new Error("bad history file");
    return data;
  } catch {
    return { tag, versions: [] };
  }
}

async function writeHistoryFile(outputDir: string, history: HistoryFile): Promise<void> {
  const dir = historyDir(outputDir, history.tag);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "history.json"), JSON.stringify(history, null, 2) + "\n", "utf8");
}

/**
 * Records a baseline replacement: moves the previous baseline folder (if
 * there was one) into the archive as the version it was, appends the new
 * version, and prunes old archives. Called by accept/restore after the new
 * baseline has been swapped in.
 */
export async function recordNewVersion(options: {
  outputDir: string;
  tag: string;
  /** Folder holding the baseline that was just replaced, or null if there wasn't one. */
  previousDir: string | null;
  /** When the replaced baseline was created (its manifest capturedAt), for version 1. */
  previousCreatedAt?: string;
  source: BaselineVersion["source"];
  at: Date;
  keep?: number;
}): Promise<BaselineVersion> {
  const history = await readHistoryFile(options.outputDir, options.tag);

  // First replacement ever: the baseline being replaced becomes version 1.
  if (history.versions.length === 0 && options.previousDir) {
    history.versions.push({
      version: 1,
      createdAt: options.previousCreatedAt ?? options.at.toISOString(),
      source: { type: "accept", fromTag: options.tag, pages: null, screenshots: 0 },
    });
  }
  const previousVersion = history.versions.at(-1)?.version ?? 0;

  if (options.previousDir && previousVersion > 0) {
    const archive = versionDir(options.outputDir, options.tag, previousVersion);
    await mkdir(historyDir(options.outputDir, options.tag), { recursive: true });
    await rm(archive, { recursive: true, force: true });
    await rename(options.previousDir, archive);
  }

  const next: BaselineVersion = {
    version: previousVersion + 1,
    createdAt: options.at.toISOString(),
    source: options.source,
  };
  history.versions.push(next);
  await writeHistoryFile(options.outputDir, history);
  await pruneArchives(options.outputDir, options.tag, options.keep ?? DEFAULT_KEEP_VERSIONS);
  return next;
}

/** Deletes all but the newest `keep` archived version folders. History entries are kept. */
async function pruneArchives(outputDir: string, tag: string, keep: number): Promise<void> {
  const dir = historyDir(outputDir, tag);
  const archived = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(1)))
    .sort((a, b) => b - a);
  for (const version of archived.slice(Math.max(0, keep))) {
    await rm(join(dir, `v${version}`), { recursive: true, force: true });
  }
}

/** The history of a baseline tag, newest version first. */
export async function getBaselineHistory(
  outputDir: string,
  tag = "baseline"
): Promise<BaselineHistory> {
  const history = await readHistoryFile(outputDir, tag);
  const currentVersion = history.versions.at(-1)?.version ?? null;
  return {
    tag,
    currentVersion,
    versions: [...history.versions].reverse().map((v) => ({
      ...v,
      current: v.version === currentVersion,
      archived: v.version !== currentVersion && existsSync(versionDir(outputDir, tag, v.version)),
    })),
  };
}

/** The manifest of an archived (or the current) baseline version, or null if it's gone. */
export async function readVersionManifest(
  outputDir: string,
  tag: string,
  version: number
): Promise<CaptureManifest | null> {
  const history = await readHistoryFile(outputDir, tag);
  if (!history.versions.some((v) => v.version === version)) return null;
  if (history.versions.at(-1)?.version === version) {
    return readManifest(outputDir, tag).catch(() => null);
  }
  try {
    const raw = await readFile(join(versionDir(outputDir, tag, version), "manifest.json"), "utf8");
    return JSON.parse(raw) as CaptureManifest;
  } catch {
    return null;
  }
}
