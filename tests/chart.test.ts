/**
 * Tests for the trend chart helpers (public/js/chart.js).
 *
 * Ticket: P041
 */

import { describe, expect, it } from "vitest";
import {
  axisTicks,
  describePoint,
  formatRate,
  labelIndexes,
  layoutBars,
  niceMax,
  pointLabel,
  trendOptions,
} from "../public/js/chart.js";

const point = (over: Record<string, unknown> = {}) => ({
  label: "2026-09-25",
  runs: 2,
  failedRuns: 1,
  pagesChecked: 10,
  pagesFailed: 3,
  pagesReview: 1,
  realBugs: 2,
  acceptableChanges: 0,
  uncertain: 1,
  regressionRate: 0.3,
  failedRunRate: 0.5,
  ...over,
});

describe("trendOptions", () => {
  it("defaults to daily, last 30 days", () => {
    expect(trendOptions(new URLSearchParams())).toEqual({ period: "day", days: 30 });
  });
  it("accepts known values", () => {
    expect(trendOptions(new URLSearchParams("period=run&days=90"))).toEqual({
      period: "run",
      days: 90,
    });
    expect(trendOptions({ period: "week", days: "7" })).toEqual({ period: "week", days: 7 });
  });
  it("ignores unknown or unsafe values", () => {
    expect(trendOptions(new URLSearchParams("period=hour&days=12"))).toEqual({
      period: "day",
      days: 30,
    });
    expect(trendOptions({ period: "__proto__", days: "abc" })).toEqual({ period: "day", days: 30 });
  });
});

describe("niceMax / axisTicks", () => {
  it.each([
    [0, 1],
    [-3, 1],
    [NaN, 1],
    [1, 1],
    [3, 5],
    [7, 10],
    [11, 20],
    [48, 50],
    [51, 100],
    [120, 200],
  ])("niceMax(%s) = %s", (max, top) => {
    expect(niceMax(max)).toBe(top);
  });

  it("gives whole-number ticks from 0 to the top", () => {
    expect(axisTicks(1)).toEqual([0, 1]);
    expect(axisTicks(5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(axisTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(axisTicks(20)).toEqual([0, 4, 8, 12, 16, 20]);
    expect(axisTicks(50)).toEqual([0, 10, 20, 30, 40, 50]);
  });
});

describe("pointLabel", () => {
  it("formats days, weeks and runs", () => {
    expect(pointLabel({ label: "2026-09-05" }, "day")).toBe("5 Sep");
    expect(pointLabel({ label: "2026-01-12" }, "week")).toBe("w/c 12 Jan");
    expect(pointLabel({ label: "2026-09-05T10:00:00.000Z", runId: 12 }, "run")).toBe("#12");
  });
  it("falls back to the raw label", () => {
    expect(pointLabel({ label: "odd" }, "day")).toBe("odd");
  });
});

describe("describePoint", () => {
  it("summarises a bucket", () => {
    expect(describePoint(point(), "day")).toBe(
      "25 Sep: 3 failing, 1 needs review, 2 real bugs of 10 pages, 2 runs"
    );
  });
  it("uses singulars and leaves out zero bugs", () => {
    expect(describePoint(point({ runs: 1, realBugs: 1 }), "week")).toBe(
      "Week of 25 Sep: 3 failing, 1 needs review, 1 real bug of 10 pages, 1 run"
    );
    expect(describePoint(point({ realBugs: 0 }), "day")).not.toContain("real bug");
  });
  it("describes runs and empty buckets", () => {
    expect(describePoint(point({ runId: 7, runs: 1 }), "run")).toBe(
      "Run #7: 3 failing, 1 needs review, 2 real bugs of 10 pages"
    );
    expect(describePoint(point({ runs: 0 }), "day")).toBe("25 Sep: no runs");
  });
});

describe("labelIndexes", () => {
  it("shows every label when they fit", () => {
    expect([...labelIndexes(5, 10)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
  it("thins labels but always keeps the last one", () => {
    const shown = labelIndexes(30, 10);
    expect(shown.size).toBeLessThanOrEqual(10);
    expect(shown.has(29)).toBe(true);
  });
  it("handles no points", () => {
    expect(labelIndexes(0, 10).size).toBe(0);
  });
});

describe("layoutBars", () => {
  const size = { width: 400, height: 100 };

  it("stacks failing under needs review on a nice scale", () => {
    const layout = layoutBars(
      [point({ pagesFailed: 3, pagesReview: 1 }), point({ pagesFailed: 0, pagesReview: 0 })],
      size
    );
    expect(layout.top).toBe(5);
    const [a, b] = layout.bars;
    expect(a.fail).toEqual({ y: 40, height: 60 });
    expect(a.review).toEqual({ y: 20, height: 20 });
    expect(b.fail.height).toBe(0);
    expect(b.review.height).toBe(0);
    // Two slots of 200px; bars are 70% of a slot, capped at 40px, centred.
    expect(a.width).toBe(40);
    expect(a.x).toBe(80);
    expect(b.centre).toBe(300);
  });

  it("marks empty buckets and survives no data", () => {
    const layout = layoutBars([point({ runs: 0, pagesFailed: 0, pagesReview: 0 })], size);
    expect(layout.top).toBe(1);
    expect(layout.bars[0].empty).toBe(true);
    expect(layoutBars([], size).bars).toEqual([]);
  });
});

describe("formatRate", () => {
  it.each([
    [null, "–"],
    [undefined, "–"],
    [0, "0%"],
    [0.0123, "1.2%"],
    [0.3, "30%"],
    [1, "100%"],
  ])("%s -> %s", (rate, text) => {
    expect(formatRate(rate)).toBe(text);
  });
});
