/**
 * Tests for the SQLite schema and migrations.
 *
 * Ticket: P032
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import {
  getDatabase,
  loadRun,
  migrate,
  saveRun,
  SCHEMA_VERSION,
  schemaVersion,
  type RunRow,
} from "../src/report/persistence.js";

let dir: string;
let db: Database.Database;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-db-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db = getDatabase(":memory:");
});
afterEach(() => {
  if (db.open) db.close();
});

const insertRun = (overrides: Record<string, unknown> = {}) =>
  db
    .prepare(
      `INSERT INTO runs (created_at, baseline_tag, current_tag, status, headline)
       VALUES (@created_at, @baseline_tag, @current_tag, @status, @headline)`
    )
    .run({
      created_at: "2026-09-25T01:00:00.000Z",
      baseline_tag: "baseline",
      current_tag: "current",
      status: "pass",
      headline: "PASS: no changes (1 page checked)",
      ...overrides,
    }).lastInsertRowid as number;

const insertDiff = (runId: number, overrides: Record<string, unknown> = {}) =>
  db
    .prepare(
      `INSERT INTO page_diffs (run_id, page, viewport, status, compared, skip_reason, changed,
                               verdict, confidence, percent_changed)
       VALUES (@run_id, @page, @viewport, @status, @compared, @skip_reason, @changed,
               @verdict, @confidence, @percent_changed)`
    )
    .run({
      run_id: runId,
      page: "home",
      viewport: "desktop",
      status: "pass",
      compared: 1,
      skip_reason: null,
      changed: 0,
      verdict: null,
      confidence: null,
      percent_changed: 0,
      ...overrides,
    });

const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("getDatabase (P032)", () => {
  it("creates the runs and page_diffs tables at the current schema version", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["page_diffs", "runs"]));
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("has the columns the rest of pixelguard relies on", () => {
    expect(columns("runs")).toEqual(
      expect.arrayContaining([
        "id",
        "created_at",
        "target_url",
        "baseline_tag",
        "current_tag",
        "change_description",
        "status",
        "headline",
        "judged",
        "judge_model",
        "total_pages",
        "pages_fail",
        "real_bugs",
        "acceptable_changes",
        "uncertain",
        "skipped",
        "report_path",
        "json_path",
      ])
    );
    expect(columns("page_diffs")).toEqual(
      expect.arrayContaining([
        "run_id",
        "page",
        "viewport",
        "status",
        "compared",
        "skip_reason",
        "changed",
        "pixel_diff_count",
        "percent_changed",
        "diff_image_path",
        "verdict",
        "confidence",
        "explanation",
        "observed_changes",
        "judged_by",
        "judge_error",
        "ignored_regions",
        "expected_change_regions",
      ])
    );
  });

  it("indexes runs by date and diffs by run and page", () => {
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["idx_runs_created_at", "idx_page_diffs_run", "idx_page_diffs_page"])
    );
  });

  it("turns on foreign keys", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates a database file (and its folder) with WAL journaling", () => {
    const path = join(dir, "nested", "data", "pixelguard.db");
    const fileDb = getDatabase(path);
    expect(existsSync(path)).toBe(true);
    expect(fileDb.pragma("journal_mode", { simple: true })).toBe("wal");
    fileDb.close();
  });

  it("reopening an existing database keeps its data and doesn't re-run migrations", () => {
    const path = join(dir, "reopen.db");
    const first = getDatabase(path);
    first
      .prepare(
        "INSERT INTO runs (created_at, baseline_tag, current_tag, status, headline) VALUES ('t', 'a', 'b', 'pass', 'h')"
      )
      .run();
    first.close();

    const second = getDatabase(path);
    expect(schemaVersion(second)).toBe(SCHEMA_VERSION);
    expect((second.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
    second.close();
  });

  it("refuses a database created by a newer pixelguard", () => {
    const path = join(dir, "future.db");
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => getDatabase(path)).toThrow(/schema version 2.*only knows up to 1/);
  });

  it("explains a path that can't be opened", () => {
    // A folder can't be opened as a database file.
    expect(() => getDatabase(dir)).toThrow(/Could not open the database/);
  });

  it("migrate() on an up-to-date database does nothing", () => {
    migrate(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("schema rules", () => {
  it("stores a run with sensible defaults", () => {
    const id = insertRun();
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
    expect(row).toMatchObject({
      id: 1,
      status: "pass",
      judged: 0,
      real_bugs: 0,
      total_pages: 0,
      target_url: null,
    });
  });

  it.each([
    ["an unknown run status", () => insertRun({ status: "ok" })],
    ["a missing created_at", () => insertRun({ created_at: null })],
    ["an unknown verdict", () => insertDiff(insertRun(), { verdict: "Bug", changed: 1 })],
    ["confidence 11", () => insertDiff(insertRun(), { confidence: 11, changed: 1 })],
    ["confidence 0", () => insertDiff(insertRun(), { confidence: 0, changed: 1 })],
    ["percent_changed over 100", () => insertDiff(insertRun(), { percent_changed: 101 })],
    [
      "a skipped screenshot without a reason",
      () => insertDiff(insertRun(), { compared: 0, changed: null, skip_reason: null }),
    ],
    [
      "a compared screenshot with a skip reason",
      () => insertDiff(insertRun(), { skip_reason: "why?" }),
    ],
    ["a diff for a run that doesn't exist", () => insertDiff(999)],
  ])("rejects %s", (_label, insert) => {
    expect(insert).toThrow(/constraint/i);
  });

  it("accepts a skipped screenshot with a reason and no diff numbers", () => {
    const runId = insertRun();
    insertDiff(runId, {
      compared: 0,
      changed: null,
      percent_changed: null,
      skip_reason: 'not in "current"',
      status: "review",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM page_diffs").get() as { n: number }).n).toBe(1);
  });

  it("allows only one row per page/viewport in a run", () => {
    const runId = insertRun();
    insertDiff(runId);
    expect(() => insertDiff(runId)).toThrow(/UNIQUE/);
    expect(() => insertDiff(insertRun())).not.toThrow(); // same page in another run is fine
  });

  it("deleting a run deletes its page diffs", () => {
    const runId = insertRun();
    insertDiff(runId, { viewport: "desktop" });
    insertDiff(runId, { viewport: "mobile" });
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM page_diffs").get() as { n: number }).n).toBe(0);
  });
});

function result(page: string, viewport: string, extra: Partial<DiffResult> = {}): DiffResult {
  return {
    page,
    viewport,
    pixelDiffCount: 0,
    totalPixels: 1000,
    percentChanged: 0,
    changed: false,
    sizeChanged: false,
    baselineSize: { width: 100, height: 10 },
    currentSize: { width: 100, height: 10 },
    diffImagePath: `diffs/b-vs-c/${viewport}/${page}.png`,
    baselineImagePath: `screenshots/baseline/${viewport}/${page}.png`,
    currentImagePath: `screenshots/current/${viewport}/${page}.png`,
    ...extra,
  };
}

describe("saveRun (P033)", () => {
  const judgedRun = () => ({
    targetUrl: "https://shop.example.com",
    baselineTag: "baseline",
    currentTag: "current",
    changeDescription: "New checkout button",
    createdAt: new Date("2026-09-25T09:00:00.000Z"),
    reportPath: "report.md",
    jsonPath: "diffs.json",
    results: [
      result("checkout", "desktop", {
        changed: true,
        pixelDiffCount: 120,
        percentChanged: 12,
        verdict: "Acceptable Change",
        confidence: 9,
        explanation: "Matches the note.",
        observedChanges: ["Button is green"],
        judgedBy: "claude-sonnet-5",
        expectedChangeRegions: [
          { label: "Promo", kind: "ad", rect: { x: 0, y: 0, width: 10, height: 5 } },
        ],
      }),
      result("checkout", "mobile", {
        changed: true,
        pixelDiffCount: 50,
        percentChanged: 5,
        sizeChanged: true,
        currentSize: { width: 100, height: 12 },
        verdict: "Real Bug",
        confidence: 8,
        explanation: "Button overlaps price.",
        judgedBy: "claude-sonnet-5",
        ignoredRegions: [{ label: "Clock", rect: { x: 1, y: 2, width: 3, height: 4 } }],
      }),
      result("home", "desktop"),
    ],
    skipped: [{ page: "blog", viewport: "desktop", reason: 'not in "current"' }],
  });

  it("saves the run with its summary and returns its id", () => {
    const id = saveRun(db, judgedRun());
    const saved = loadRun(db, id)!;
    expect(saved.run).toEqual({
      id,
      created_at: "2026-09-25T09:00:00.000Z",
      target_url: "https://shop.example.com",
      baseline_tag: "baseline",
      current_tag: "current",
      change_description: "New checkout button",
      status: "fail",
      headline: "FAIL: 1 real bug on 1 page, 1 not compared, 1 acceptable change (3 pages checked)",
      judged: 1,
      judge_model: "claude-sonnet-5",
      total_pages: 3,
      pages_pass: 1,
      pages_review: 1,
      pages_fail: 1,
      screenshots_total: 3,
      screenshots_changed: 2,
      real_bugs: 1,
      acceptable_changes: 1,
      uncertain: 0,
      judge_errors: 0,
      not_judged: 0,
      skipped: 1,
      report_path: "report.md",
      json_path: "diffs.json",
    });
  });

  it("saves one page_diffs row per screenshot, including skipped ones", () => {
    const { diffs } = loadRun(db, saveRun(db, judgedRun()))!;
    expect(diffs.map((d) => [d.page, d.viewport, d.status, d.compared])).toEqual([
      ["checkout", "desktop", "pass", 1],
      ["checkout", "mobile", "fail", 1],
      ["home", "desktop", "pass", 1],
      ["blog", "desktop", "review", 0],
    ]);
  });

  it("stores the verdict, sizes, image paths and JSON fields", () => {
    const { diffs } = loadRun(db, saveRun(db, judgedRun()))!;
    const [desktop, mobile, home, blog] = diffs;
    expect(desktop).toMatchObject({
      changed: 1,
      pixel_diff_count: 120,
      total_pixels: 1000,
      percent_changed: 12,
      verdict: "Acceptable Change",
      confidence: 9,
      explanation: "Matches the note.",
      judged_by: "claude-sonnet-5",
      judge_error: null,
      ignored_regions: null,
      diff_image_path: "diffs/b-vs-c/desktop/checkout.png",
      baseline_image_path: "screenshots/baseline/desktop/checkout.png",
    });
    expect(JSON.parse(desktop.observed_changes!)).toEqual(["Button is green"]);
    expect(JSON.parse(desktop.expected_change_regions!)[0].label).toBe("Promo");

    expect(mobile).toMatchObject({ size_changed: 1, current_height: 12, baseline_height: 10 });
    expect(JSON.parse(mobile.ignored_regions!)).toEqual([
      { label: "Clock", rect: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
    expect(mobile.observed_changes).toBeNull(); // not given

    expect(home).toMatchObject({ changed: 0, verdict: null, confidence: null });
    expect(blog).toMatchObject({
      skip_reason: 'not in "current"',
      changed: null,
      diff_image_path: null,
    });
  });

  it("records a run that wasn't judged, and a failed judgement", () => {
    const id = saveRun(db, {
      baselineTag: "a",
      currentTag: "b",
      results: [
        result("home", "desktop", { changed: true, pixelDiffCount: 3, percentChanged: 0.3 }),
        result("home", "mobile", {
          changed: true,
          pixelDiffCount: 3,
          percentChanged: 0.3,
          verdict: "Uncertain",
          explanation: "Could not be judged automatically: timeout",
          judgeError: "timeout",
          judgedBy: "claude-sonnet-5",
        }),
      ],
    });
    const { run, diffs } = loadRun(db, id)!;
    expect(run).toMatchObject({
      status: "review",
      judged: 1,
      not_judged: 1,
      judge_errors: 1,
      target_url: null,
      change_description: null,
    });
    expect(diffs[1]).toMatchObject({
      verdict: "Uncertain",
      judge_error: "timeout",
      confidence: null,
    });
  });

  it("marks runs without any verdicts as not judged", () => {
    const { run } = loadRun(db, saveRun(db, { baselineTag: "a", currentTag: "b", results: [] }))!;
    expect(run).toMatchObject({ judged: 0, judge_model: null, status: "pass", total_pages: 0 });
  });

  it("keeps separate runs separate, with increasing ids", () => {
    const first = saveRun(db, judgedRun());
    const second = saveRun(db, { ...judgedRun(), results: [], skipped: [] });
    expect(second).toBeGreaterThan(first);
    expect(loadRun(db, first)!.diffs).toHaveLength(4);
    expect(loadRun(db, second)!.diffs).toHaveLength(0);
  });

  it("saves nothing at all if any row fails (single transaction)", () => {
    const broken = {
      baselineTag: "a",
      currentTag: "b",
      results: [result("home", "desktop"), result("home", "desktop")], // duplicate page/viewport
    };
    expect(() => saveRun(db, broken)).toThrow(/UNIQUE/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM page_diffs").get() as { n: number }).n).toBe(0);
  });

  it("loadRun returns null for a run that doesn't exist", () => {
    expect(loadRun(db, 42)).toBeNull();
  });
});
