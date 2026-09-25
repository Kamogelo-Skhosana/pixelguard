/**
 * Tests for the dashboard's run history API, over real HTTP against a
 * database seeded with saveRun().
 *
 * Ticket: P036
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/dashboard/app.js";
import type { RunDetailDto, RunListDto } from "../src/dashboard/queries.js";
import { rollupPages } from "../src/judge/aggregate.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name: string, file: string) => `tests/fixtures/diff/${name}/${file}.png`;

/** A judged run with real fixture images (id 6), used by the detail tests. */
const detailResults: DiffResult[] = [
  {
    ...result("checkout", "desktop", "Real Bug"),
    pixelDiffCount: 1200,
    totalPixels: 24000,
    percentChanged: 5,
    confidence: 9,
    explanation: "Button changed colour unexpectedly.",
    observedChanges: ["Button is green now"],
    expectedChangeRegions: [
      { label: "Promo", kind: "ad", rect: { x: 0, y: 0, width: 20, height: 10 } },
    ],
    baselineImagePath: fx("button-colour", "baseline"),
    currentImagePath: fx("button-colour", "current"),
    diffImagePath: fx("element-shift", "current"),
  },
  {
    ...result("checkout", "mobile", "Acceptable Change"),
    sizeChanged: true,
    currentSize: { width: 10, height: 12 },
    ignoredRegions: [{ label: "Clock", rect: { x: 1, y: 2, width: 3, height: 4 } }],
  },
  {
    ...result("home", "desktop"),
    baselineImagePath: fx("identical", "baseline"),
    currentImagePath: fx("identical", "current"),
    diffImagePath: "tests/fixtures/diff/does-not-exist.png",
  },
];
const detailSkipped = [{ page: "blog", viewport: "desktop", reason: 'not in "current"' }];

function seedDetailRun() {
  saveRun(db, {
    results: detailResults,
    skipped: detailSkipped,
    targetUrl: "https://shop.example.com",
    baselineTag: "baseline",
    currentTag: "current",
    changeDescription: "New button",
    createdAt: new Date("2026-09-24T08:00:00.000Z"),
  });
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
  seedDetailRun();
  server = createApp({ db, projectDir: repoRoot }).listen(0, "127.0.0.1");
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
    expect(list.runs.map((r) => r.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(list).toMatchObject({ total: 6, limit: 50, offset: 0 });
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
    expect(first.runs.map((r) => r.id)).toEqual([6, 5]);
    expect(second.runs.map((r) => r.id)).toEqual([4, 3]);
    expect(last.runs.map((r) => r.id)).toEqual([2, 1]);
    expect([first.total, second.total, last.total]).toEqual([6, 6, 6]);
  });

  it("returns an empty page past the end", async () => {
    const { status, body } = await get("/api/runs?offset=100");
    expect(status).toBe(200);
    expect(body).toMatchObject({ runs: [], total: 6 });
  });

  it.each([
    ["fail", [6, 2]],
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
    const shop = (await get(`/api/runs?target=${encodeURIComponent("https://shop.example.com")}`))
      .body as RunListDto;
    expect(shop.total).toBe(5);
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

describe("GET /api/runs/:id (P037)", () => {
  const detail = async () => (await get("/api/runs/6")).body as RunDetailDto;

  it("returns the run summary and its pages in capture order", async () => {
    const d = await detail();
    expect(d.run).toMatchObject({ id: 6, status: "fail", changeDescription: "New button" });
    expect(d.pages.map((p) => [p.page, p.status])).toEqual([
      ["checkout", "fail"],
      ["home", "pass"],
      ["blog", "review"],
    ]);
  });

  it("uses exactly the same page summaries as the CLI and report", async () => {
    const expected = rollupPages(detailResults, detailSkipped).map((p) => p.summary);
    expect((await detail()).pages.map((p) => p.summary)).toEqual(expected);
  });

  it("returns every screenshot's details, with JSON fields parsed", async () => {
    const [desktop, mobile] = (await detail()).pages[0].screenshots;
    expect(desktop).toMatchObject({
      viewport: "desktop",
      status: "fail",
      compared: true,
      skipReason: null,
      changed: true,
      pixelDiffCount: 1200,
      totalPixels: 24000,
      percentChanged: 5,
      sizeChanged: false,
      baselineSize: { width: 10, height: 10 },
      verdict: "Real Bug",
      confidence: 9,
      explanation: "Button changed colour unexpectedly.",
      observedChanges: ["Button is green now"],
      judgedBy: "claude-sonnet-5",
      judgeError: null,
      ignoredRegions: [],
      expectedChangeRegions: [
        { label: "Promo", kind: "ad", rect: { x: 0, y: 0, width: 20, height: 10 } },
      ],
    });
    expect(mobile).toMatchObject({
      sizeChanged: true,
      currentSize: { width: 10, height: 12 },
      ignoredRegions: [{ label: "Clock", rect: { x: 1, y: 2, width: 3, height: 4 } }],
      observedChanges: [],
    });
  });

  it("includes skipped screenshots with their reason and no images", async () => {
    const blog = (await detail()).pages.find((p) => p.page === "blog")!;
    expect(blog.screenshots).toEqual([
      expect.objectContaining({
        compared: false,
        skipReason: 'not in "current"',
        changed: null,
        percentChanged: null,
        images: { baseline: null, current: null, diff: null },
      }),
    ]);
  });

  it("gives image URLs for compared screenshots", async () => {
    const shot = (await detail()).pages[0].screenshots[0];
    expect(shot.images).toEqual({
      baseline: `/api/runs/6/diffs/${shot.id}/baseline`,
      current: `/api/runs/6/diffs/${shot.id}/current`,
      diff: `/api/runs/6/diffs/${shot.id}/diff`,
    });
  });

  it("returns 404 for a run that doesn't exist", async () => {
    const r = await get("/api/runs/999");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Run 999 not found" });
  });

  it.each(["abc", "0", "-1", "1.5"])("returns 400 for id %s", async (id) => {
    expect((await get(`/api/runs/${id}`)).status).toBe(400);
  });

  it("still routes /api/runs/trend separately (not as an id)", async () => {
    expect((await get("/api/runs/trend")).status).toBe(501);
  });

  it("copes with an unreadable JSON column", async () => {
    const shot = (await detail()).pages[0].screenshots[0];
    db.prepare("UPDATE page_diffs SET observed_changes = 'not json' WHERE id = ?").run(shot.id);
    try {
      expect((await detail()).pages[0].screenshots[0].observedChanges).toEqual([]);
    } finally {
      db.prepare("UPDATE page_diffs SET observed_changes = ? WHERE id = ?").run(
        JSON.stringify(["Button is green now"]),
        shot.id
      );
    }
  });
});

describe("GET /api/runs/:id/diffs/:diffId/:kind (P037)", () => {
  const ids = async () => {
    const d = (await get("/api/runs/6")).body as RunDetailDto;
    return {
      checkout: d.pages[0].screenshots[0].id,
      home: d.pages[1].screenshots[0].id,
      blog: d.pages[2].screenshots[0].id,
    };
  };

  it.each([
    ["baseline", fx("button-colour", "baseline")],
    ["current", fx("button-colour", "current")],
    ["diff", fx("element-shift", "current")],
  ])("serves the %s PNG recorded for that screenshot", async (kind, file) => {
    const { checkout } = await ids();
    const res = await fetch(`${base}/api/runs/6/diffs/${checkout}/${kind}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(readFileSync(resolve(repoRoot, file)))).toBe(true);
  });

  it("returns 404 when the screenshot belongs to a different run", async () => {
    const { checkout } = await ids();
    expect((await get(`/api/runs/1/diffs/${checkout}/baseline`)).status).toBe(404);
  });

  it("returns 404 for a skipped screenshot (no images)", async () => {
    const { blog } = await ids();
    expect((await get(`/api/runs/6/diffs/${blog}/diff`)).status).toBe(404);
  });

  it("returns 404 with a clear message when the file was cleaned up", async () => {
    const { home } = await ids();
    const r = await get(`/api/runs/6/diffs/${home}/diff`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no longer exists/);
  });

  it("never serves a non-PNG path, even if one is stored", async () => {
    const { home } = await ids();
    db.prepare("UPDATE page_diffs SET baseline_image_path = 'package.json' WHERE id = ?").run(home);
    try {
      expect((await get(`/api/runs/6/diffs/${home}/baseline`)).status).toBe(404);
    } finally {
      db.prepare("UPDATE page_diffs SET baseline_image_path = ? WHERE id = ?").run(
        fx("identical", "baseline"),
        home
      );
    }
  });

  it.each([
    "/api/runs/6/diffs/abc/diff",
    "/api/runs/6/diffs/1/thumbnail",
    "/api/runs/x/diffs/1/diff",
  ])("returns 400 for %s", async (path) => {
    expect((await get(path)).status).toBe(400);
  });
});
