/**
 * Tests for the regression trend endpoint.
 *
 * Ticket: P038
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/dashboard/app.js";
import type { TrendDto } from "../src/dashboard/queries.js";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { getDatabase, saveRun } from "../src/report/persistence.js";

const NOW = new Date("2026-09-25T12:00:00.000Z"); // a Friday
let db: Database.Database;
let server: Server;
let base: string;

function shot(page: string, verdict?: Verdict): DiffResult {
  return {
    page,
    viewport: "desktop",
    pixelDiffCount: verdict ? 5 : 0,
    totalPixels: 100,
    percentChanged: verdict ? 5 : 0,
    changed: Boolean(verdict),
    sizeChanged: false,
    baselineSize: { width: 10, height: 10 },
    currentSize: { width: 10, height: 10 },
    diffImagePath: "d.png",
    baselineImagePath: "b.png",
    currentImagePath: "c.png",
    ...(verdict && { verdict, confidence: 8, explanation: "x", judgedBy: "m" }),
  };
}

function save(createdAt: string, results: DiffResult[], targetUrl = "https://shop.example.com") {
  saveRun(db, {
    results,
    targetUrl,
    baselineTag: "b",
    currentTag: "c",
    createdAt: new Date(createdAt),
  });
}

beforeAll(async () => {
  db = getDatabase(":memory:");
  save("2026-09-10T09:00:00.000Z", [shot("home", "Real Bug")]); // outside a 7-day window
  save("2026-09-21T08:00:00.000Z", [shot("home"), shot("about")]); // Mon: pass, 2 pages
  save("2026-09-21T17:00:00.000Z", [shot("home", "Real Bug"), shot("about", "Acceptable Change")]); // Mon: fail
  save("2026-09-23T10:00:00.000Z", [shot("home", "Uncertain")]); // Wed: review
  save("2026-09-25T09:00:00.000Z", [shot("post", "Real Bug")], "https://blog.example.com"); // Fri: fail
  server = createApp({ db, now: () => NOW }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const get = async (qs = "") => {
  const res = await fetch(`${base}/api/runs/trend${qs}`);
  return {
    status: res.status,
    body: (await res.json()) as TrendDto & { error?: string; issues?: string[] },
  };
};

describe("GET /api/runs/trend (P038)", () => {
  it("gives one point per day in the window, including empty days", async () => {
    const { status, body } = await get("?days=7");
    expect(status).toBe(200);
    expect(body).toMatchObject({ period: "day", from: "2026-09-19", to: "2026-09-25" });
    expect(body.points.map((p) => [p.label, p.runs])).toEqual([
      ["2026-09-19", 0],
      ["2026-09-20", 0],
      ["2026-09-21", 2],
      ["2026-09-22", 0],
      ["2026-09-23", 1],
      ["2026-09-24", 0],
      ["2026-09-25", 1],
    ]);
  });

  it("calculates the regression rate as failed pages / pages checked", async () => {
    const { body } = await get("?days=7");
    const monday = body.points.find((p) => p.label === "2026-09-21")!;
    expect(monday).toEqual({
      label: "2026-09-21",
      runs: 2,
      failedRuns: 1,
      pagesChecked: 4,
      pagesFailed: 1,
      pagesReview: 0,
      realBugs: 1,
      acceptableChanges: 1,
      uncertain: 0,
      regressionRate: 0.25,
      failedRunRate: 0.5,
    });
  });

  it("uses null rates (not 0) for days with no runs, so charts show a gap", async () => {
    const { body } = await get("?days=7");
    const empty = body.points.find((p) => p.label === "2026-09-22")!;
    expect(empty).toMatchObject({
      runs: 0,
      pagesChecked: 0,
      regressionRate: null,
      failedRunRate: null,
    });
  });

  it("totals the whole window", async () => {
    const { body } = await get("?days=7");
    expect(body.totals).toMatchObject({
      runs: 4,
      failedRuns: 2,
      pagesChecked: 6,
      pagesFailed: 2,
      pagesReview: 1,
      realBugs: 2,
      regressionRate: 0.3333,
      failedRunRate: 0.5,
    });
  });

  it("groups by week, starting on Monday", async () => {
    const { body } = await get("?period=week&days=14");
    expect(body.from).toBe("2026-09-12");
    expect(body.points.map((p) => [p.label, p.runs])).toEqual([
      ["2026-09-07", 0], // the 12th-13th fall in the week of Monday the 7th
      ["2026-09-14", 0],
      ["2026-09-21", 4],
    ]);
  });

  it("gives one point per run for period=run, oldest first", async () => {
    const { body } = await get("?period=run&days=7");
    expect(body.points.map((p) => [p.runId, p.label, p.regressionRate])).toEqual([
      [2, "2026-09-21T08:00:00.000Z", 0],
      [3, "2026-09-21T17:00:00.000Z", 0.5],
      [4, "2026-09-23T10:00:00.000Z", 0],
      [5, "2026-09-25T09:00:00.000Z", 1],
    ]);
  });

  it("defaults to the last 30 days, which includes the older run", async () => {
    const { body } = await get();
    expect(body).toMatchObject({ period: "day", from: "2026-08-27", to: "2026-09-25" });
    expect(body.points).toHaveLength(30);
    expect(body.totals.runs).toBe(5);
  });

  it("filters by target", async () => {
    const { body } = await get(`?days=7&target=${encodeURIComponent("https://blog.example.com")}`);
    expect(body.totals).toMatchObject({ runs: 1, realBugs: 1, regressionRate: 1 });
  });

  it("works with no runs at all", async () => {
    const { body } = await get(`?days=3&target=${encodeURIComponent("https://none.example.com")}`);
    expect(body.points).toHaveLength(3);
    expect(body.totals).toMatchObject({ runs: 0, regressionRate: null });
  });

  it.each([
    ["period=month", /period/],
    ["days=0", /days/],
    ["days=366", /days/],
    ["days=abc", /days/],
    ["limit=5", /unknown parameter\(s\): limit/],
  ])("rejects ?%s with a 400", async (qs, issue) => {
    const { status, body } = await get(`?${qs}`);
    expect(status).toBe(400);
    expect(body.issues?.join(" ")).toMatch(issue);
  });
});
