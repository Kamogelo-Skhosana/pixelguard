/**
 * Database queries behind the dashboard API, and the JSON shapes they
 * return. Rows are converted to camelCase objects with grouped counts, so
 * the frontend never depends on SQLite column names.
 *
 * Tickets: P036, P037, P038
 */

import type Database from "better-sqlite3";
import type { DiffResult, ImageRect, Verdict } from "../diff/models.js";
import { rollupPages, type SkippedScreenshot } from "../judge/aggregate.js";
import type { PageDiffRow, PageStatusValue, RunRow } from "../report/persistence.js";

/** One run in the run history list (GET /api/runs). */
export interface RunSummaryDto {
  id: number;
  createdAt: string;
  targetUrl: string | null;
  baselineTag: string;
  currentTag: string;
  changeDescription: string | null;
  status: PageStatusValue;
  headline: string;
  judged: boolean;
  judgeModel: string | null;
  pages: { total: number; pass: number; review: number; fail: number };
  screenshots: { total: number; changed: number };
  verdicts: {
    realBugs: number;
    acceptableChanges: number;
    uncertain: number;
    judgeErrors: number;
    notJudged: number;
    skipped: number;
  };
  reportPath: string | null;
  jsonPath: string | null;
}

export function toRunSummary(row: RunRow): RunSummaryDto {
  return {
    id: row.id,
    createdAt: row.created_at,
    targetUrl: row.target_url,
    baselineTag: row.baseline_tag,
    currentTag: row.current_tag,
    changeDescription: row.change_description,
    status: row.status,
    headline: row.headline,
    judged: row.judged === 1,
    judgeModel: row.judge_model,
    pages: {
      total: row.total_pages,
      pass: row.pages_pass,
      review: row.pages_review,
      fail: row.pages_fail,
    },
    screenshots: { total: row.screenshots_total, changed: row.screenshots_changed },
    verdicts: {
      realBugs: row.real_bugs,
      acceptableChanges: row.acceptable_changes,
      uncertain: row.uncertain,
      judgeErrors: row.judge_errors,
      notJudged: row.not_judged,
      skipped: row.skipped,
    },
    reportPath: row.report_path,
    jsonPath: row.json_path,
  };
}

export interface ListRunsOptions {
  limit: number;
  offset: number;
  status?: PageStatusValue;
  targetUrl?: string;
}

export interface RunListDto {
  runs: RunSummaryDto[];
  /** Runs matching the filters, before paging. */
  total: number;
  limit: number;
  offset: number;
}

/** Run history, newest first (ties broken by id, so the order is stable). */
export function listRuns(db: Database.Database, options: ListRunsOptions): RunListDto {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: options.limit, offset: options.offset };
  if (options.status) {
    where.push("status = @status");
    params.status = options.status;
  }
  if (options.targetUrl) {
    where.push("target_url = @targetUrl");
    params.targetUrl = options.targetUrl;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT * FROM runs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
    )
    .all(params) as RunRow[];
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM runs ${whereSql}`).get(params) as {
    total: number;
  };

  return { runs: rows.map(toRunSummary), total, limit: options.limit, offset: options.offset };
}

// ---------------------------------------------------------------------------
// Run detail (P037)
// ---------------------------------------------------------------------------

export type ImageKind = "baseline" | "current" | "diff";
export const IMAGE_KINDS: readonly ImageKind[] = ["baseline", "current", "diff"];

/** One page/viewport in a run (GET /api/runs/:id). */
export interface ScreenshotDto {
  id: number;
  viewport: string;
  status: PageStatusValue;
  /** False when the screenshot couldn't be compared (see skipReason). */
  compared: boolean;
  skipReason: string | null;
  changed: boolean | null;
  pixelDiffCount: number | null;
  totalPixels: number | null;
  percentChanged: number | null;
  sizeChanged: boolean | null;
  baselineSize: { width: number; height: number } | null;
  currentSize: { width: number; height: number } | null;
  verdict: Verdict | null;
  confidence: number | null;
  explanation: string | null;
  observedChanges: string[];
  judgedBy: string | null;
  judgeError: string | null;
  ignoredRegions: { label: string; rect: ImageRect }[];
  expectedChangeRegions: { label: string; kind: string; rect: ImageRect }[];
  /** URLs of the images served by the API, or null when there's no image. */
  images: Record<ImageKind, string | null>;
}

export interface PageDetailDto {
  page: string;
  status: PageStatusValue;
  /** Same one-line summary as the CLI and Markdown report (P026). */
  summary: string;
  screenshots: ScreenshotDto[];
}

export interface RunDetailDto {
  run: RunSummaryDto;
  pages: PageDetailDto[];
}

/** Parses a JSON array column, falling back to [] if it's empty or unreadable. */
function jsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function size(width: number | null, height: number | null) {
  return width === null || height === null ? null : { width, height };
}

function imagePath(row: PageDiffRow, kind: ImageKind): string | null {
  return kind === "baseline"
    ? row.baseline_image_path
    : kind === "current"
      ? row.current_image_path
      : row.diff_image_path;
}

export function toScreenshot(row: PageDiffRow): ScreenshotDto {
  const images = Object.fromEntries(
    IMAGE_KINDS.map((kind) => [
      kind,
      imagePath(row, kind) ? `/api/runs/${row.run_id}/diffs/${row.id}/${kind}` : null,
    ])
  ) as Record<ImageKind, string | null>;

  return {
    id: row.id,
    viewport: row.viewport,
    status: row.status,
    compared: row.compared === 1,
    skipReason: row.skip_reason,
    changed: row.changed === null ? null : row.changed === 1,
    pixelDiffCount: row.pixel_diff_count,
    totalPixels: row.total_pixels,
    percentChanged: row.percent_changed,
    sizeChanged: row.size_changed === null ? null : row.size_changed === 1,
    baselineSize: size(row.baseline_width, row.baseline_height),
    currentSize: size(row.current_width, row.current_height),
    verdict: row.verdict,
    confidence: row.confidence,
    explanation: row.explanation,
    observedChanges: jsonArray<string>(row.observed_changes),
    judgedBy: row.judged_by,
    judgeError: row.judge_error,
    ignoredRegions: jsonArray(row.ignored_regions),
    expectedChangeRegions: jsonArray(row.expected_change_regions),
    images,
  };
}

/** Rebuilds the DiffResult a compared row was saved from, for the page rollup. */
function toDiffResult(row: PageDiffRow): DiffResult {
  return {
    page: row.page,
    viewport: row.viewport,
    pixelDiffCount: row.pixel_diff_count ?? 0,
    totalPixels: row.total_pixels ?? 0,
    percentChanged: row.percent_changed ?? 0,
    changed: row.changed === 1,
    sizeChanged: row.size_changed === 1,
    baselineSize: size(row.baseline_width, row.baseline_height) ?? { width: 0, height: 0 },
    currentSize: size(row.current_width, row.current_height) ?? { width: 0, height: 0 },
    diffImagePath: row.diff_image_path ?? "",
    baselineImagePath: row.baseline_image_path ?? "",
    currentImagePath: row.current_image_path ?? "",
    ...(row.verdict && { verdict: row.verdict }),
    ...(row.confidence !== null && { confidence: row.confidence }),
    ...(row.explanation && { explanation: row.explanation }),
    ...(row.judge_error && { judgeError: row.judge_error }),
  };
}

/** One run with its pages and screenshots, or null if there's no such run. */
export function getRunDetail(db: Database.Database, runId: number): RunDetailDto | null {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) return null;
  const rows = db
    .prepare("SELECT * FROM page_diffs WHERE run_id = ? ORDER BY id")
    .all(runId) as PageDiffRow[];

  // Re-run the same page rollup the CLI and report use, so summaries match exactly.
  const compared = rows.filter((r) => r.compared === 1);
  const skipped: SkippedScreenshot[] = rows
    .filter((r) => r.compared === 0)
    .map((r) => ({ page: r.page, viewport: r.viewport, reason: r.skip_reason ?? "not compared" }));
  const pages = rollupPages(compared.map(toDiffResult), skipped);

  return {
    run: toRunSummary(run),
    pages: pages.map((p) => ({
      page: p.page,
      status: p.status,
      summary: p.summary,
      screenshots: rows.filter((r) => r.page === p.page).map(toScreenshot),
    })),
  };
}

/** The stored file path of one image, only if it belongs to that run. */
export function getImagePath(
  db: Database.Database,
  runId: number,
  diffId: number,
  kind: ImageKind
): string | null {
  const row = db
    .prepare("SELECT * FROM page_diffs WHERE id = ? AND run_id = ?")
    .get(diffId, runId) as PageDiffRow | undefined;
  return row ? imagePath(row, kind) : null;
}

// ---------------------------------------------------------------------------
// Regression trend (P038)
// ---------------------------------------------------------------------------

export type TrendPeriod = "day" | "week" | "run";

export interface TrendCounts {
  runs: number;
  failedRuns: number;
  pagesChecked: number;
  pagesFailed: number;
  pagesReview: number;
  realBugs: number;
  acceptableChanges: number;
  uncertain: number;
  /** pagesFailed / pagesChecked (0-1), or null when nothing was checked. */
  regressionRate: number | null;
  /** failedRuns / runs (0-1), or null when there were no runs. */
  failedRunRate: number | null;
}

export interface TrendPoint extends TrendCounts {
  /** "2026-09-25" for day, the Monday "2026-09-21" for week, or the run's timestamp. */
  label: string;
  /** Set for period=run. */
  runId?: number;
}

export interface TrendDto {
  period: TrendPeriod;
  /** First and last day covered (YYYY-MM-DD, UTC). */
  from: string;
  to: string;
  points: TrendPoint[];
  totals: TrendCounts;
}

export interface TrendOptions {
  period: TrendPeriod;
  /** How many days back from `now` to include (the current day counts as one). */
  days: number;
  targetUrl?: string;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (iso: string) => iso.slice(0, 10);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

/** Monday (UTC) of the week containing the given YYYY-MM-DD day. */
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return toDay(new Date(d.getTime() - sinceMonday * DAY_MS));
}

const rate = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

function tally(rows: RunRow[]): TrendCounts {
  const sum = (fn: (r: RunRow) => number) => rows.reduce((n, r) => n + fn(r), 0);
  const runs = rows.length;
  const failedRuns = rows.filter((r) => r.status === "fail").length;
  const pagesChecked = sum((r) => r.total_pages);
  const pagesFailed = sum((r) => r.pages_fail);
  return {
    runs,
    failedRuns,
    pagesChecked,
    pagesFailed,
    pagesReview: sum((r) => r.pages_review),
    realBugs: sum((r) => r.real_bugs),
    acceptableChanges: sum((r) => r.acceptable_changes),
    uncertain: sum((r) => r.uncertain),
    regressionRate: rate(pagesFailed, pagesChecked),
    failedRunRate: rate(failedRuns, runs),
  };
}

/**
 * Regression trend over the last `days` days. Day and week periods include
 * empty buckets (runs: 0, rates null) so a chart shows gaps honestly.
 */
export function getTrend(db: Database.Database, options: TrendOptions): TrendDto {
  const to = toDay(options.now);
  const from = toDay(
    new Date(new Date(`${to}T00:00:00.000Z`).getTime() - (options.days - 1) * DAY_MS)
  );

  const params: Record<string, unknown> = {
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
  };
  let sql = "SELECT * FROM runs WHERE created_at >= @from AND created_at <= @to";
  if (options.targetUrl) {
    sql += " AND target_url = @targetUrl";
    params.targetUrl = options.targetUrl;
  }
  const rows = db.prepare(`${sql} ORDER BY created_at, id`).all(params) as RunRow[];

  let points: TrendPoint[];
  if (options.period === "run") {
    points = rows.map((r) => ({ label: r.created_at, runId: r.id, ...tally([r]) }));
  } else {
    const keyOf = options.period === "day" ? dayOf : (iso: string) => weekStart(dayOf(iso));
    const buckets = new Map<string, RunRow[]>();
    // Every bucket in the window, oldest first, even the empty ones.
    for (
      let t = new Date(`${from}T00:00:00.000Z`).getTime();
      t <= new Date(`${to}T00:00:00.000Z`).getTime();
      t += DAY_MS
    ) {
      const key = keyOf(new Date(t).toISOString());
      if (!buckets.has(key)) buckets.set(key, []);
    }
    for (const row of rows) buckets.get(keyOf(row.created_at))?.push(row);
    points = [...buckets.entries()].map(([label, bucket]) => ({ label, ...tally(bucket) }));
  }

  return { period: options.period, from, to, points, totals: tally(rows) };
}
