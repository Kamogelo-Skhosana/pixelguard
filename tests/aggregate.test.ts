/**
 * Tests for the per-page verdict rollup.
 *
 * Ticket: P026
 */

import { describe, expect, it } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import { rollupPages, summarizeRun, viewportOutcome } from "../src/judge/aggregate.js";

function r(page: string, viewport: string, extra: Partial<DiffResult> = {}): DiffResult {
  return {
    page,
    viewport,
    pixelDiffCount: 0,
    totalPixels: 100,
    percentChanged: 0,
    changed: false,
    sizeChanged: false,
    baselineSize: { width: 10, height: 10 },
    currentSize: { width: 10, height: 10 },
    diffImagePath: "d",
    baselineImagePath: "b",
    currentImagePath: "c",
    ...extra,
  };
}

const changed = { changed: true, pixelDiffCount: 10, percentChanged: 10 };
const bug = (confidence = 9) => ({
  ...changed,
  verdict: "Real Bug" as const,
  confidence,
  explanation: "Broken.",
});
const ok = (confidence = 9) => ({
  ...changed,
  verdict: "Acceptable Change" as const,
  confidence,
  explanation: "Fine.",
});
const unsure = (confidence = 4) => ({
  ...changed,
  verdict: "Uncertain" as const,
  confidence,
  explanation: "?",
});
const judgeFailed = {
  ...changed,
  verdict: "Uncertain" as const,
  explanation: "Could not be judged automatically: timeout",
  judgeError: "timeout",
};

describe("viewportOutcome", () => {
  it.each([
    ["unchanged", {}, "pass", "unchanged"],
    ["Acceptable Change", ok(8), "pass", "Acceptable Change (8/10)"],
    ["Real Bug", bug(9), "fail", "Real Bug (9/10)"],
    ["Uncertain", unsure(4), "review", "Uncertain (4/10)"],
    ["a judge error", judgeFailed, "review", "changed, couldn't be judged: timeout"],
    ["changed but not judged", changed, "review", "changed, not judged"],
  ])("%s -> %s", (_label, extra, status, reason) => {
    expect(viewportOutcome(r("home", "desktop", extra))).toMatchObject({ status, reason });
  });

  it("carries the verdict details through", () => {
    expect(viewportOutcome(r("home", "mobile", bug(7)))).toEqual({
      viewport: "mobile",
      status: "fail",
      reason: "Real Bug (7/10)",
      changed: true,
      percentChanged: 10,
      verdict: "Real Bug",
      confidence: 7,
      explanation: "Broken.",
    });
  });
});

describe("rollupPages (P026)", () => {
  it("fails a page when any viewport has a Real Bug", () => {
    const [page] = rollupPages([
      r("checkout", "desktop", ok()),
      r("checkout", "tablet"),
      r("checkout", "mobile", bug(9)),
    ]);
    expect(page).toMatchObject({
      page: "checkout",
      status: "fail",
      summary: "Real Bug on mobile (9/10)",
    });
    expect(page.viewports.map((v) => v.status)).toEqual(["pass", "pass", "fail"]);
  });

  it("a Real Bug outranks Uncertain on the same page", () => {
    const [page] = rollupPages([r("a", "desktop", unsure()), r("a", "mobile", bug())]);
    expect(page.status).toBe("fail");
  });

  it("names every viewport with a bug", () => {
    const [page] = rollupPages([
      r("a", "desktop", bug(9)),
      r("a", "tablet", bug(8)),
      r("a", "mobile", bug(7)),
    ]);
    expect(page.summary).toBe("Real Bug on desktop (9/10), tablet (8/10) and mobile (7/10)");
  });

  it.each([
    ["an Uncertain verdict", unsure(4), "Needs review: mobile Uncertain (4/10)"],
    ["a judge error", judgeFailed, "Needs review: mobile changed, couldn't be judged: timeout"],
    ["an unjudged change", changed, "Needs review: mobile changed, not judged"],
  ])("puts a page up for review for %s", (_label, extra, summary) => {
    const [page] = rollupPages([r("about", "desktop", ok()), r("about", "mobile", extra)]);
    expect(page).toMatchObject({ status: "review", summary });
  });

  it("passes a page with only acceptable or no changes", () => {
    const pages = rollupPages([
      r("home", "desktop", ok()),
      r("home", "mobile", ok()),
      r("about", "desktop"),
      r("about", "mobile"),
    ]);
    expect(pages.map((p) => [p.page, p.status, p.summary])).toEqual([
      ["home", "pass", "Acceptable changes on desktop and mobile"],
      ["about", "pass", "No changes"],
    ]);
  });

  it("counts skipped screenshots as needing review", () => {
    const pages = rollupPages(
      [r("home", "desktop")],
      [
        { page: "home", viewport: "mobile", reason: 'failed in "current": HTTP 500' },
        { page: "new-page", viewport: "desktop", reason: 'not in "baseline"' },
      ]
    );
    expect(pages.map((p) => [p.page, p.status])).toEqual([
      ["home", "review"],
      ["new-page", "review"],
    ]);
    expect(pages[0].summary).toBe(
      'Needs review: mobile not compared: failed in "current": HTTP 500'
    );
  });

  it("keeps pages in the order they first appear", () => {
    const pages = rollupPages([r("b", "desktop"), r("a", "desktop"), r("b", "mobile")]);
    expect(pages.map((p) => p.page)).toEqual(["b", "a"]);
    expect(pages[0].viewports.map((v) => v.viewport)).toEqual(["desktop", "mobile"]);
  });

  it("returns nothing for no results", () => {
    expect(rollupPages([])).toEqual([]);
  });
});

describe("summarizeRun (P027)", () => {
  it("counts every verdict across the run", () => {
    const s = summarizeRun(
      [
        r("checkout", "desktop", bug(9)),
        r("checkout", "mobile", bug(8)),
        r("home", "desktop", ok()),
        r("home", "mobile", ok()),
        r("home", "tablet", ok()),
        r("about", "desktop", unsure()),
        r("about", "mobile", judgeFailed),
        r("blog", "desktop", changed),
        r("contact", "desktop"),
      ],
      [{ page: "new", viewport: "desktop", reason: 'not in "baseline"' }]
    );
    expect(s).toEqual({
      status: "fail",
      headline:
        "FAIL: 2 real bugs on 1 page, 1 uncertain, 1 couldn't be judged, 1 changed but not judged, 1 not compared, 3 acceptable changes (6 pages checked)",
      totalPages: 6,
      realBugs: 2,
      acceptableChanges: 3,
      uncertain: 1,
      judgeErrors: 1,
      notJudged: 1,
      skipped: 1,
      pages: { pass: 2, review: 3, fail: 1 },
      screenshots: { total: 9, changed: 8, unchanged: 1 },
    });
  });

  it("uses the worst page as the run status", () => {
    expect(summarizeRun([r("a", "d", ok()), r("b", "d", unsure())]).status).toBe("review");
    expect(summarizeRun([r("a", "d", ok()), r("b", "d")]).status).toBe("pass");
  });

  it.each([
    [[r("a", "d", bug(9))], "FAIL: 1 real bug on 1 page (1 page checked)"],
    [[r("a", "d", ok()), r("b", "d", ok())], "PASS: 2 acceptable changes (2 pages checked)"],
    [[r("a", "d"), r("a", "m")], "PASS: no changes (1 page checked)"],
    [[r("a", "d", unsure())], "REVIEW: 1 uncertain (1 page checked)"],
    [[], "PASS: nothing to compare"],
  ])("headline %#", (results, headline) => {
    expect(summarizeRun(results).headline).toBe(headline);
  });

  it("counts a failed judgement separately from a real Uncertain", () => {
    const s = summarizeRun([r("a", "d", judgeFailed)]);
    expect([s.uncertain, s.judgeErrors]).toEqual([0, 1]);
  });

  it("is re-exported from judge.ts for convenience", async () => {
    const judge = await import("../src/judge/judge.js");
    expect(judge.summarizeRun).toBe(summarizeRun);
  });
});
