/**
 * Database queries behind the dashboard API, and the JSON shapes they
 * return. Rows are converted to camelCase objects with grouped counts, so
 * the frontend never depends on SQLite column names.
 *
 * Tickets: P036, P037, P038
 */

import type Database from "better-sqlite3";
import type { PageStatusValue, RunRow } from "../report/persistence.js";

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
