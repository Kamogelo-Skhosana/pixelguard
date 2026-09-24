/**
 * Edge cases for verdict aggregation: mixed verdicts on one page,
 * all-uncertain runs, inconsistent data, and invariants that must hold
 * for any run.
 *
 * Ticket: P028
 */

import { describe, expect, it } from "vitest";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { rollupPages, summarizeRun, type SkippedScreenshot } from "../src/judge/aggregate.js";

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

const judged = (verdict: Verdict, confidence = 8): Partial<DiffResult> => ({
  changed: true,
  pixelDiffCount: 5,
  percentChanged: 5,
  verdict,
  confidence,
  explanation: verdict,
});
const judgeFailed = (error = "timeout"): Partial<DiffResult> => ({
  changed: true,
  pixelDiffCount: 5,
  percentChanged: 5,
  verdict: "Uncertain",
  explanation: `Could not be judged automatically: ${error}`,
  judgeError: error,
});
const notJudged: Partial<DiffResult> = { changed: true, pixelDiffCount: 5, percentChanged: 5 };

describe("mixed verdicts on one page", () => {
  it("every kind of outcome on one page: the Real Bug decides", () => {
    const [page] = rollupPages(
      [
        r("checkout", "desktop", judged("Acceptable Change")),
        r("checkout", "tablet", judged("Uncertain", 3)),
        r("checkout", "mobile", judged("Real Bug", 9)),
        r("checkout", "wide", judgeFailed()),
        r("checkout", "narrow", notJudged),
        r("checkout", "print"),
      ],
      [{ page: "checkout", viewport: "tv", reason: 'not in "baseline"' }]
    );
    expect(page.status).toBe("fail");
    expect(page.summary).toBe("Real Bug on mobile (9/10)");
    expect(page.viewports.map((v) => [v.viewport, v.status])).toEqual([
      ["desktop", "pass"],
      ["tablet", "review"],
      ["mobile", "fail"],
      ["wide", "review"],
      ["narrow", "review"],
      ["print", "pass"],
      ["tv", "review"],
    ]);
  });

  it("without a bug, every review reason is listed in the summary", () => {
    const [page] = rollupPages([
      r("about", "desktop", judged("Uncertain", 4)),
      r("about", "tablet", judgeFailed("HTTP 529")),
      r("about", "mobile", notJudged),
      r("about", "wide", judged("Acceptable Change")),
    ]);
    expect(page.status).toBe("review");
    expect(page.summary).toBe(
      "Needs review: desktop Uncertain (4/10); tablet changed, couldn't be judged: HTTP 529; mobile changed, not judged"
    );
  });

  it("lists four or more bug viewports with commas and 'and'", () => {
    const [page] = rollupPages(
      ["a", "b", "c", "d"].map((v, i) => r("p", v, judged("Real Bug", 9 - i)))
    );
    expect(page.summary).toBe("Real Bug on a (9/10), b (8/10), c (7/10) and d (6/10)");
  });

  it("a Real Bug with confidence 1 still fails the page", () => {
    expect(rollupPages([r("p", "d", judged("Real Bug", 1))])[0].status).toBe("fail");
  });

  it("a single-viewport page works like any other", () => {
    const [page] = rollupPages([r("solo", "desktop", judged("Acceptable Change"))]);
    expect(page).toMatchObject({ status: "pass", summary: "Acceptable changes on desktop" });
  });
});

describe("all-uncertain and all-failed runs", () => {
  it("an all-Uncertain run needs review, never fails", () => {
    const s = summarizeRun([
      r("home", "desktop", judged("Uncertain", 5)),
      r("home", "mobile", judged("Uncertain", 2)),
      r("about", "desktop", judged("Uncertain", 4)),
    ]);
    expect(s).toMatchObject({
      status: "review",
      realBugs: 0,
      uncertain: 3,
      pages: { pass: 0, review: 2, fail: 0 },
      headline: "REVIEW: 3 uncertain (2 pages checked)",
    });
  });

  it("a run where every judgement failed (e.g. bad API key) needs review", () => {
    const s = summarizeRun([
      r("home", "desktop", judgeFailed("401")),
      r("about", "desktop", judgeFailed("401")),
    ]);
    expect(s).toMatchObject({
      status: "review",
      uncertain: 0,
      judgeErrors: 2,
      headline: "REVIEW: 2 couldn't be judged (2 pages checked)",
    });
  });

  it("a run with only skipped screenshots needs review", () => {
    const s = summarizeRun([], [{ page: "home", viewport: "desktop", reason: "failed" }]);
    expect(s).toMatchObject({
      status: "review",
      totalPages: 1,
      skipped: 1,
      headline: "REVIEW: 1 not compared (1 page checked)",
    });
  });

  it("an unchanged run passes", () => {
    const s = summarizeRun([r("a", "desktop"), r("a", "mobile"), r("b", "desktop")]);
    expect(s).toMatchObject({
      status: "pass",
      headline: "PASS: no changes (2 pages checked)",
      screenshots: { total: 3, changed: 0, unchanged: 3 },
    });
  });

  it("pluralises pages correctly when bugs span several pages", () => {
    const s = summarizeRun([r("a", "d", judged("Real Bug")), r("b", "d", judged("Real Bug"))]);
    expect(s.headline).toBe("FAIL: 2 real bugs on 2 pages (2 pages checked)");
  });
});

describe("inconsistent data is handled safely", () => {
  it("a verdict on an unchanged screenshot is ignored", () => {
    const stray = r("home", "desktop", { verdict: "Real Bug", confidence: 9, explanation: "?" });
    expect(rollupPages([stray])[0].status).toBe("pass");
    expect(summarizeRun([stray]).realBugs).toBe(0);
  });

  it("a judge error wins over a verdict that shouldn't be there", () => {
    const odd = r("home", "desktop", { ...judged("Real Bug"), judgeError: "reply cut off" });
    expect(rollupPages([odd])[0].status).toBe("review");
    expect(summarizeRun([odd])).toMatchObject({ realBugs: 0, judgeErrors: 1, status: "review" });
  });

  it("a page that only appears in the skipped list still gets a verdict", () => {
    const pages = rollupPages(
      [r("home", "desktop")],
      [{ page: "brand-new", viewport: "mobile", reason: 'not in "baseline"' }]
    );
    expect(pages.map((p) => [p.page, p.status])).toEqual([
      ["home", "pass"],
      ["brand-new", "review"],
    ]);
  });

  it("the same page/viewport listed twice is kept twice, not merged away", () => {
    const [page] = rollupPages([
      r("home", "desktop", judged("Acceptable Change")),
      r("home", "desktop", judged("Real Bug")),
    ]);
    expect(page.viewports).toHaveLength(2);
    expect(page.status).toBe("fail"); // the worse one is never hidden
  });

  it("empty input gives empty output", () => {
    expect(rollupPages([], [])).toEqual([]);
    expect(summarizeRun([], [])).toMatchObject({ status: "pass", totalPages: 0 });
  });
});

describe("invariants that hold for any run", () => {
  /** Small deterministic PRNG so failures are reproducible. */
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
  }

  const kinds = ["unchanged", "bug", "ok", "unsure", "failed", "notJudged"] as const;
  const make = (kind: (typeof kinds)[number], page: string, viewport: string) =>
    ({
      unchanged: r(page, viewport),
      bug: r(page, viewport, judged("Real Bug")),
      ok: r(page, viewport, judged("Acceptable Change")),
      unsure: r(page, viewport, judged("Uncertain")),
      failed: r(page, viewport, judgeFailed()),
      notJudged: r(page, viewport, notJudged),
    })[kind];

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))("random run #%i", (seed) => {
    const random = rng(seed);
    const results: DiffResult[] = [];
    const skipped: SkippedScreenshot[] = [];
    const pageCount = 1 + Math.floor(random() * 8);
    for (let p = 0; p < pageCount; p++) {
      for (const viewport of ["desktop", "tablet", "mobile"]) {
        if (random() < 0.1) {
          skipped.push({ page: `page${p}`, viewport, reason: "failed" });
        } else {
          results.push(make(kinds[Math.floor(random() * kinds.length)], `page${p}`, viewport));
        }
      }
    }

    const pages = rollupPages(results, skipped);
    const s = summarizeRun(results, skipped);

    // Every page is counted exactly once.
    expect(s.pages.pass + s.pages.review + s.pages.fail).toBe(s.totalPages);
    expect(s.totalPages).toBe(pages.length);
    // Every changed screenshot lands in exactly one bucket.
    expect(s.realBugs + s.acceptableChanges + s.uncertain + s.judgeErrors + s.notJudged).toBe(
      s.screenshots.changed
    );
    expect(s.screenshots.changed + s.screenshots.unchanged).toBe(results.length);
    // Every screenshot appears under its page.
    expect(pages.reduce((n, p) => n + p.viewports.length, 0)).toBe(results.length + skipped.length);
    // Run status matches the pages: fail iff any bug; pass iff every page passes.
    expect(s.status === "fail").toBe(s.realBugs > 0);
    expect(s.status === "pass").toBe(s.pages.pass === s.totalPages);
    // A page fails exactly when one of its screenshots is a Real Bug.
    for (const page of pages) {
      expect(page.status === "fail").toBe(page.viewports.some((v) => v.status === "fail"));
    }
  });

  it("handles a large run quickly", () => {
    const results = Array.from({ length: 3000 }, (_, i) =>
      r(`page${i % 1000}`, ["desktop", "tablet", "mobile"][i % 3], judged("Acceptable Change"))
    );
    const start = performance.now();
    const s = summarizeRun(results);
    expect(s.totalPages).toBe(1000);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
