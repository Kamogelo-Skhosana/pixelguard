/**
 * Tests for the dashboard's run history API, over real HTTP against a
 * database seeded with saveRun().
 *
 * Ticket: P036
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/dashboard/app.js";
import type { RunListDto } from "../src/dashboard/queries.js";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { getDatabase, saveRun } from "../src/report/persistence.js";

let db: Database.Database;
let server: Server;
let base: string;

function result(page: string, viewport: string, verdict?: Verdict): DiffResult {
  return {
    page,
    viewport,
    pixelDiffCount: verdict ? 10 : 0,
    totalPixels: 100,
    percentChanged: verdict ? 10 : 0,
    changed: Boolean(verdict),
    sizeChanged: false,
    baselineSize: { width: 10, height: 10 },
    currentSize: { width: 10, height: 10 },
    diffImagePath: "d.png",
    baselineImagePath: "b.png",
    currentImagePath: "c.png",
    ...(verdict && { verdict, confidence: 8, explanation: verdict, judgedBy: "claude-sonnet-5" }),
  };
}

/** Seeds runs oldest-first; ids 1..5. */
function seed() {
  const runs: [string, string, DiffResult[]][] = [
    ["2026-09-20T08:00:00.000Z", "https://shop.example.com", [result("home", "desktop")]],
    [
      "2026-09-21T08:00:00.000Z",
      "https://shop.example.com",
      [result("home", "desktop", "Real Bug"), result("home", "mobile", "Acceptable Change")],
    ],
    [
      "2026-09-22T08:00:00.000Z",
      "https://blog.example.com",
      [result("post", "desktop", "Uncertain")],
    ],
    [
      "2026-09-23T08:00:00.000Z",
      "https://shop.example.com",
      [result("home", "desktop", "Acceptable Change")],
    ],
    ["2026-09-23T08:00:00.000Z", "https://shop.example.com", [result("home", "desktop")]], // same time
  ];
  for (const [createdAt, targetUrl, results] of runs) {
    saveRun(db, {
      results,
      targetUrl,
      baselineTag: "baseline",
      currentTag: "current",
      createdAt: new Date(createdAt),
    });
  }
}

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  db = getDatabase(":memory:");
  seed();
  server = createApp({ db }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

describe("GET /api/runs (P036)", () => {
  it("lists runs newest first, with a stable order for equal times", async () => {
    const { status, body } = await get("/api/runs");
    expect(status).toBe(200);
    const list = body as RunListDto;
    expect(list.runs.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
    expect(list).toMatchObject({ total: 5, limit: 50, offset: 0 });
  });

  it("returns a clean camelCase summary for each run", async () => {
    const { body } = await get("/api/runs");
    const run2 = (body as RunListDto).runs.find((r) => r.id === 2);
    expect(run2).toEqual({
      id: 2,
      createdAt: "2026-09-21T08:00:00.000Z",
      targetUrl: "https://shop.example.com",
      baselineTag: "baseline",
      currentTag: "current",
      changeDescription: null,
      status: "fail",
      headline: "FAIL: 1 real bug on 1 page, 1 acceptable change (1 page checked)",
      judged: true,
      judgeModel: "claude-sonnet-5",
      pages: { total: 1, pass: 0, review: 0, fail: 1 },
      screenshots: { total: 2, changed: 2 },
      verdicts: {
        realBugs: 1,
        acceptableChanges: 1,
        uncertain: 0,
        judgeErrors: 0,
        notJudged: 0,
        skipped: 0,
      },
      reportPath: null,
      jsonPath: null,
    });
  });

  it("pages with limit and offset, keeping the total", async () => {
    const first = (await get("/api/runs?limit=2")).body as RunListDto;
    const second = (await get("/api/runs?limit=2&offset=2")).body as RunListDto;
    const last = (await get("/api/runs?limit=2&offset=4")).body as RunListDto;
    expect(first.runs.map((r) => r.id)).toEqual([5, 4]);
    expect(second.runs.map((r) => r.id)).toEqual([3, 2]);
    expect(last.runs.map((r) => r.id)).toEqual([1]);
    expect([first.total, second.total, last.total]).toEqual([5, 5, 5]);
  });

  it("returns an empty page past the end", async () => {
    const { status, body } = await get("/api/runs?offset=100");
    expect(status).toBe(200);
    expect(body).toMatchObject({ runs: [], total: 5 });
  });

  it.each([
    ["fail", [2]],
    ["review", [3]],
    ["pass", [5, 4, 1]],
  ])("filters by status=%s", async (status, ids) => {
    const { body } = await get(`/api/runs?status=${status}`);
    expect((body as RunListDto).runs.map((r) => r.id)).toEqual(ids);
    expect((body as RunListDto).total).toBe(ids.length);
  });

  it("filters by target URL, and combines filters", async () => {
    const blog = (await get(`/api/runs?target=${encodeURIComponent("https://blog.example.com")}`))
      .body as RunListDto;
    expect(blog.runs.map((r) => r.id)).toEqual([3]);

    const shopPass = (
      await get(`/api/runs?status=pass&target=${encodeURIComponent("https://shop.example.com")}`)
    ).body as RunListDto;
    expect(shopPass.runs.map((r) => r.id)).toEqual([5, 4, 1]);
  });

  it.each([
    ["limit=0", /limit/],
    ["limit=201", /limit/],
    ["limit=abc", /limit/],
    ["offset=-1", /offset/],
    ["status=broken", /status/],
    ["status=fail&status=pass", /status/],
    ["sort=asc", /unknown parameter\(s\): sort/],
  ])("rejects ?%s with a 400 explaining why", async (qs, issue) => {
    const { status, body } = await get(`/api/runs?${qs}`);
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid query");
    expect(body.issues.join(" ")).toMatch(issue);
  });

  it("treats a SQL-looking target as plain text", async () => {
    const { status, body } = await get(`/api/runs?target=${encodeURIComponent("' OR 1=1 --")}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ runs: [], total: 0 });
  });

  it("works with an empty database", async () => {
    const empty = getDatabase(":memory:");
    const s = createApp({ db: empty }).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/runs`);
      expect(await res.json()).toEqual({ runs: [], total: 0, limit: 50, offset: 0 });
    } finally {
      await new Promise((r) => s.close(r));
      empty.close();
    }
  });
});
