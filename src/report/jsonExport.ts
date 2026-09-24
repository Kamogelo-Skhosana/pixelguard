/**
 * JSON export of diff results.
 *
 * Writes a self-describing report file (for `pixelguard diff --output diffs.json`):
 *
 *   {
 *     "schemaVersion": 1,
 *     "generatedAt": "2026-09-24T21:00:00.000Z",
 *     "baselineTag": "baseline",
 *     "currentTag": "current",
 *     "targetUrl": "https://example.com",
 *     "summary": { "total": 6, "changed": 2, "unchanged": 4, "sizeChanged": 1,
 *                  "biggestChange": { "page": "about", "viewport": "desktop", "percentChanged": 20 } },
 *     "results": [ ...DiffResult ]
 *   }
 *
 * Ticket: P017
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiffResult } from "../diff/models.js";

export const JSON_REPORT_SCHEMA_VERSION = 1;

export interface JsonReportMeta {
  baselineTag?: string;
  currentTag?: string;
  targetUrl?: string;
  /** Defaults to now. */
  generatedAt?: Date;
}

export interface JsonReportSummary {
  total: number;
  changed: number;
  unchanged: number;
  sizeChanged: number;
  biggestChange: { page: string; viewport: string; percentChanged: number } | null;
}

export interface JsonReport {
  schemaVersion: number;
  generatedAt: string;
  baselineTag?: string;
  currentTag?: string;
  targetUrl?: string;
  summary: JsonReportSummary;
  results: DiffResult[];
}

export function summarizeDiffs(results: DiffResult[]): JsonReportSummary {
  const changed = results.filter((r) => r.changed);
  const biggest = changed.reduce<DiffResult | null>(
    (max, r) => (!max || r.percentChanged > max.percentChanged ? r : max),
    null
  );
  return {
    total: results.length,
    changed: changed.length,
    unchanged: results.length - changed.length,
    sizeChanged: results.filter((r) => r.sizeChanged).length,
    biggestChange: biggest
      ? { page: biggest.page, viewport: biggest.viewport, percentChanged: biggest.percentChanged }
      : null,
  };
}

/** Builds the report object without writing it. */
export function buildJsonReport(results: DiffResult[], meta: JsonReportMeta = {}): JsonReport {
  return {
    schemaVersion: JSON_REPORT_SCHEMA_VERSION,
    generatedAt: (meta.generatedAt ?? new Date()).toISOString(),
    ...(meta.baselineTag !== undefined && { baselineTag: meta.baselineTag }),
    ...(meta.currentTag !== undefined && { currentTag: meta.currentTag }),
    ...(meta.targetUrl !== undefined && { targetUrl: meta.targetUrl }),
    summary: summarizeDiffs(results),
    results,
  };
}

/**
 * Writes the diff results as a JSON report to path (pretty-printed, parent
 * folders created as needed). Returns the report that was written.
 */
export async function exportJson(
  results: DiffResult[],
  path: string,
  meta: JsonReportMeta = {}
): Promise<JsonReport> {
  const report = buildJsonReport(results, meta);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

/** Reads a report written by exportJson(), checking it's a pixelguard report. */
export async function readJsonReport(path: string): Promise<JsonReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read JSON report ${path}: ${(err as Error).message}`);
  }
  const report = parsed as Partial<JsonReport>;
  if (
    typeof report !== "object" ||
    report === null ||
    report.schemaVersion !== JSON_REPORT_SCHEMA_VERSION ||
    !Array.isArray(report.results)
  ) {
    throw new Error(
      `${path} is not a pixelguard JSON report (expected schemaVersion ${JSON_REPORT_SCHEMA_VERSION})`
    );
  }
  return report as JsonReport;
}
