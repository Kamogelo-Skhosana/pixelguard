/**
 * SQLite persistence for runs and page diffs.
 *
 * Schema (version 1):
 *
 *   runs        one row per `pixelguard diff` run: when, what was compared,
 *               the overall status and the run summary counts (P027)
 *   page_diffs  one row per page/viewport in a run: pixel diff numbers,
 *               image paths, and the judge's verdict — including screenshots
 *               that couldn't be compared (compared = 0, with a skip_reason)
 *
 * Deleting a run deletes its page_diffs (ON DELETE CASCADE).
 *
 * Migrations: the schema version is kept in SQLite's built-in user_version.
 * getDatabase() applies any newer migrations in a transaction, so existing
 * databases upgrade in place when the schema changes later.
 *
 * saveRun() (P033) stores a whole run in one transaction; loadRun() reads it back.
 *
 * Tickets: P032, P033
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DiffResult } from "../diff/models.js";
import { rollupPages, summarizeRun, type SkippedScreenshot } from "../judge/aggregate.js";

/** Ordered schema migrations. Index + 1 is the schema version it produces. */
export const MIGRATIONS: readonly string[] = [
  // ---- Version 1 (P032) ----
  `
  CREATE TABLE runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,              -- ISO 8601, UTC
    target_url           TEXT,
    baseline_tag         TEXT    NOT NULL,
    current_tag          TEXT    NOT NULL,
    change_description   TEXT,

    status               TEXT    NOT NULL CHECK (status IN ('pass', 'review', 'fail')),
    headline             TEXT    NOT NULL,
    judged               INTEGER NOT NULL DEFAULT 0 CHECK (judged IN (0, 1)),
    judge_model          TEXT,

    total_pages          INTEGER NOT NULL DEFAULT 0 CHECK (total_pages >= 0),
    pages_pass           INTEGER NOT NULL DEFAULT 0 CHECK (pages_pass >= 0),
    pages_review         INTEGER NOT NULL DEFAULT 0 CHECK (pages_review >= 0),
    pages_fail           INTEGER NOT NULL DEFAULT 0 CHECK (pages_fail >= 0),

    screenshots_total    INTEGER NOT NULL DEFAULT 0 CHECK (screenshots_total >= 0),
    screenshots_changed  INTEGER NOT NULL DEFAULT 0 CHECK (screenshots_changed >= 0),
    real_bugs            INTEGER NOT NULL DEFAULT 0 CHECK (real_bugs >= 0),
    acceptable_changes   INTEGER NOT NULL DEFAULT 0 CHECK (acceptable_changes >= 0),
    uncertain            INTEGER NOT NULL DEFAULT 0 CHECK (uncertain >= 0),
    judge_errors         INTEGER NOT NULL DEFAULT 0 CHECK (judge_errors >= 0),
    not_judged           INTEGER NOT NULL DEFAULT 0 CHECK (not_judged >= 0),
    skipped              INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),

    report_path          TEXT,
    json_path            TEXT
  );

  CREATE INDEX idx_runs_created_at ON runs (created_at);

  CREATE TABLE page_diffs (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                   INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    page                     TEXT    NOT NULL,
    viewport                 TEXT    NOT NULL,

    -- Outcome of this screenshot in the page rollup (P026).
    status                   TEXT    NOT NULL CHECK (status IN ('pass', 'review', 'fail')),
    compared                 INTEGER NOT NULL DEFAULT 1 CHECK (compared IN (0, 1)),
    skip_reason              TEXT,

    changed                  INTEGER CHECK (changed IN (0, 1)),
    pixel_diff_count         INTEGER CHECK (pixel_diff_count >= 0),
    total_pixels             INTEGER CHECK (total_pixels >= 0),
    percent_changed          REAL    CHECK (percent_changed BETWEEN 0 AND 100),
    size_changed             INTEGER CHECK (size_changed IN (0, 1)),
    baseline_width           INTEGER,
    baseline_height          INTEGER,
    current_width            INTEGER,
    current_height           INTEGER,

    baseline_image_path      TEXT,
    current_image_path       TEXT,
    diff_image_path          TEXT,

    verdict                  TEXT    CHECK (verdict IN ('Real Bug', 'Acceptable Change', 'Uncertain')),
    confidence               INTEGER CHECK (confidence BETWEEN 1 AND 10),
    explanation              TEXT,
    observed_changes         TEXT,   -- JSON array of strings
    judged_by                TEXT,
    judge_error              TEXT,

    ignored_regions          TEXT,   -- JSON array of { label, rect }
    expected_change_regions  TEXT,   -- JSON array of { label, kind, rect }

    UNIQUE (run_id, page, viewport),
    -- A skipped screenshot has a reason and no diff numbers.
    CHECK ((compared = 1 AND skip_reason IS NULL AND changed IS NOT NULL)
        OR (compared = 0 AND skip_reason IS NOT NULL AND changed IS NULL))
  );

  CREATE INDEX idx_page_diffs_run ON page_diffs (run_id);
  CREATE INDEX idx_page_diffs_page ON page_diffs (page, viewport);
  `,
];

/** The schema version this code expects. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export type PageStatusValue = "pass" | "review" | "fail";

/** A row of the runs table. */
export interface RunRow {
  id: number;
  created_at: string;
  target_url: string | null;
  baseline_tag: string;
  current_tag: string;
  change_description: string | null;
  status: PageStatusValue;
  headline: string;
  judged: 0 | 1;
  judge_model: string | null;
  total_pages: number;
  pages_pass: number;
  pages_review: number;
  pages_fail: number;
  screenshots_total: number;
  screenshots_changed: number;
  real_bugs: number;
  acceptable_changes: number;
  uncertain: number;
  judge_errors: number;
  not_judged: number;
  skipped: number;
  report_path: string | null;
  json_path: string | null;
}

/** A row of the page_diffs table. */
export interface PageDiffRow {
  id: number;
  run_id: number;
  page: string;
  viewport: string;
  status: PageStatusValue;
  compared: 0 | 1;
  skip_reason: string | null;
  changed: 0 | 1 | null;
  pixel_diff_count: number | null;
  total_pixels: number | null;
  percent_changed: number | null;
  size_changed: 0 | 1 | null;
  baseline_width: number | null;
  baseline_height: number | null;
  current_width: number | null;
  current_height: number | null;
  baseline_image_path: string | null;
  current_image_path: string | null;
  diff_image_path: string | null;
  verdict: "Real Bug" | "Acceptable Change" | "Uncertain" | null;
  confidence: number | null;
  explanation: string | null;
  observed_changes: string | null;
  judged_by: string | null;
  judge_error: string | null;
  ignored_regions: string | null;
  expected_change_regions: string | null;
}

/** Reads the schema version stored in the database. */
export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Brings the database schema up to date. Each pending migration runs in a
 * transaction together with its version bump, so a failure leaves the
 * database at the last good version.
 */
export function migrate(db: Database.Database): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `This database uses schema version ${current}, but this version of pixelguard only ` +
        `knows up to ${SCHEMA_VERSION}. Upgrade pixelguard, or point DATABASE_URL at another file.`
    );
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

/**
 * Opens (or creates) the SQLite database and brings its schema up to date.
 *
 * @param databasePath Plain SQLite file path (e.g. "./pixelguard.db"), or
 *   ":memory:" for a temporary in-memory database. Use `Settings.databasePath`,
 *   NOT the raw `DATABASE_URL` — better-sqlite3 does not understand the
 *   "sqlite:" URL prefix. Parent folders are created as needed.
 */
export function getDatabase(databasePath: string): Database.Database {
  const inMemory = databasePath === ":memory:" || databasePath === "";
  if (!inMemory) mkdirSync(dirname(databasePath), { recursive: true });

  let db: Database.Database;
  try {
    db = new Database(inMemory ? ":memory:" : databasePath);
  } catch (err) {
    throw new Error(`Could not open the database at ${databasePath}: ${(err as Error).message}`);
  }

  try {
    db.pragma("foreign_keys = ON");
    if (!inMemory) {
      // Better concurrency (the dashboard can read while a run is saved).
      db.pragma("journal_mode = WAL");
    }
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export interface SaveRunInput {
  results: DiffResult[];
  /** Screenshots that couldn't be compared — stored with compared = 0. */
  skipped?: SkippedScreenshot[];
  targetUrl?: string;
  baselineTag: string;
  currentTag: string;
  changeDescription?: string;
  /** When the run happened (default: now). */
  createdAt?: Date;
  reportPath?: string;
  jsonPath?: string;
}

const toJson = (value: unknown[] | undefined): string | null =>
  value && value.length > 0 ? JSON.stringify(value) : null;
const bool = (value: boolean): 0 | 1 => (value ? 1 : 0);

/**
 * Saves a diff run: one runs row plus one page_diffs row per page/viewport
 * (including screenshots that couldn't be compared). Everything is written
 * in a single transaction, so a run is saved completely or not at all.
 * Returns the new run's id.
 */
export function saveRun(db: Database.Database, input: SaveRunInput): number {
  const skipped = input.skipped ?? [];
  const summary = summarizeRun(input.results, skipped);
  const pages = rollupPages(input.results, skipped);
  const models = [...new Set(input.results.map((r) => r.judgedBy).filter(Boolean))];

  // Status of each screenshot, as decided by the page rollup (P026).
  const statusOf = new Map<string, PageStatusValue>();
  for (const page of pages) {
    for (const v of page.viewports) statusOf.set(`${page.page}\u0000${v.viewport}`, v.status);
  }
  const status = (page: string, viewport: string) =>
    statusOf.get(`${page}\u0000${viewport}`) ?? "review";

  const insertRun = db.prepare(`
    INSERT INTO runs (
      created_at, target_url, baseline_tag, current_tag, change_description,
      status, headline, judged, judge_model,
      total_pages, pages_pass, pages_review, pages_fail,
      screenshots_total, screenshots_changed,
      real_bugs, acceptable_changes, uncertain, judge_errors, not_judged, skipped,
      report_path, json_path
    ) VALUES (
      @created_at, @target_url, @baseline_tag, @current_tag, @change_description,
      @status, @headline, @judged, @judge_model,
      @total_pages, @pages_pass, @pages_review, @pages_fail,
      @screenshots_total, @screenshots_changed,
      @real_bugs, @acceptable_changes, @uncertain, @judge_errors, @not_judged, @skipped,
      @report_path, @json_path
    )`);

  const insertDiff = db.prepare(`
    INSERT INTO page_diffs (
      run_id, page, viewport, status, compared, skip_reason,
      changed, pixel_diff_count, total_pixels, percent_changed, size_changed,
      baseline_width, baseline_height, current_width, current_height,
      baseline_image_path, current_image_path, diff_image_path,
      verdict, confidence, explanation, observed_changes, judged_by, judge_error,
      ignored_regions, expected_change_regions
    ) VALUES (
      @run_id, @page, @viewport, @status, @compared, @skip_reason,
      @changed, @pixel_diff_count, @total_pixels, @percent_changed, @size_changed,
      @baseline_width, @baseline_height, @current_width, @current_height,
      @baseline_image_path, @current_image_path, @diff_image_path,
      @verdict, @confidence, @explanation, @observed_changes, @judged_by, @judge_error,
      @ignored_regions, @expected_change_regions
    )`);

  const save = db.transaction((): number => {
    const runId = Number(
      insertRun.run({
        created_at: (input.createdAt ?? new Date()).toISOString(),
        target_url: input.targetUrl ?? null,
        baseline_tag: input.baselineTag,
        current_tag: input.currentTag,
        change_description: input.changeDescription || null,
        status: summary.status,
        headline: summary.headline,
        judged: bool(models.length > 0),
        judge_model: models.length > 0 ? models.join(", ") : null,
        total_pages: summary.totalPages,
        pages_pass: summary.pages.pass,
        pages_review: summary.pages.review,
        pages_fail: summary.pages.fail,
        screenshots_total: summary.screenshots.total,
        screenshots_changed: summary.screenshots.changed,
        real_bugs: summary.realBugs,
        acceptable_changes: summary.acceptableChanges,
        uncertain: summary.uncertain,
        judge_errors: summary.judgeErrors,
        not_judged: summary.notJudged,
        skipped: summary.skipped,
        report_path: input.reportPath ?? null,
        json_path: input.jsonPath ?? null,
      }).lastInsertRowid
    );

    for (const r of input.results) {
      insertDiff.run({
        run_id: runId,
        page: r.page,
        viewport: r.viewport,
        status: status(r.page, r.viewport),
        compared: 1,
        skip_reason: null,
        changed: bool(r.changed),
        pixel_diff_count: r.pixelDiffCount,
        total_pixels: r.totalPixels,
        percent_changed: r.percentChanged,
        size_changed: bool(r.sizeChanged),
        baseline_width: r.baselineSize.width,
        baseline_height: r.baselineSize.height,
        current_width: r.currentSize.width,
        current_height: r.currentSize.height,
        baseline_image_path: r.baselineImagePath,
        current_image_path: r.currentImagePath,
        diff_image_path: r.diffImagePath,
        verdict: r.verdict ?? null,
        confidence: r.confidence ?? null,
        explanation: r.explanation ?? null,
        observed_changes: toJson(r.observedChanges),
        judged_by: r.judgedBy ?? null,
        judge_error: r.judgeError ?? null,
        ignored_regions: toJson(r.ignoredRegions),
        expected_change_regions: toJson(r.expectedChangeRegions),
      });
    }

    for (const s of skipped) {
      insertDiff.run({
        run_id: runId,
        page: s.page,
        viewport: s.viewport,
        status: "review",
        compared: 0,
        skip_reason: s.reason,
        changed: null,
        pixel_diff_count: null,
        total_pixels: null,
        percent_changed: null,
        size_changed: null,
        baseline_width: null,
        baseline_height: null,
        current_width: null,
        current_height: null,
        baseline_image_path: null,
        current_image_path: null,
        diff_image_path: null,
        verdict: null,
        confidence: null,
        explanation: null,
        observed_changes: null,
        judged_by: null,
        judge_error: null,
        ignored_regions: null,
        expected_change_regions: null,
      });
    }
    return runId;
  });

  return save();
}

/** Reads one saved run and its page diffs (in insertion order), or null if it doesn't exist. */
export function loadRun(
  db: Database.Database,
  runId: number
): { run: RunRow; diffs: PageDiffRow[] } | null {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) return null;
  const diffs = db
    .prepare("SELECT * FROM page_diffs WHERE run_id = ? ORDER BY id")
    .all(runId) as PageDiffRow[];
  return { run, diffs };
}
