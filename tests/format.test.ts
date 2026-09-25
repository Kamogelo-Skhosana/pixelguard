/**
 * Tests for the dashboard frontend's formatting helpers (public/js/format.js).
 *
 * Ticket: P039
 */

import { describe, expect, it } from "vitest";
import {
  buildHash,
  describeSizeChange,
  formatCount,
  formatPercent,
  screenshotLabel,
  headlineDetail,
  pageCounts,
  parseHash,
  relativeTime,
  shortTarget,
} from "../public/js/format.js";

describe("relativeTime", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");
  it.each([
    ["2026-09-25T11:59:30.000Z", "just now"],
    ["2026-09-25T12:00:30.000Z", "just now"], // slightly in the future (clock skew)
    ["2026-09-25T11:55:00.000Z", "5 min ago"],
    ["2026-09-25T09:00:00.000Z", "3 h ago"],
    ["2026-09-24T12:00:00.000Z", "1 day ago"],
    ["2026-09-20T12:00:00.000Z", "5 days ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it("shows a date for runs older than a month", () => {
    expect(relativeTime("2026-06-01T12:00:00.000Z", now)).toMatch(/2026|Jun/);
  });

  it("returns an empty string for an invalid date", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("headlineDetail", () => {
  it.each([
    ["FAIL: 2 real bugs on 1 page (3 pages checked)", "2 real bugs on 1 page (3 pages checked)"],
    ["PASS: no changes (1 page checked)", "no changes (1 page checked)"],
    ["REVIEW: 1 uncertain (1 page checked)", "1 uncertain (1 page checked)"],
    ["something else", "something else"],
  ])("%s", (headline, expected) => {
    expect(headlineDetail(headline)).toBe(expected);
  });
});

describe("shortTarget", () => {
  it.each([
    ["https://shop.example.com", "shop.example.com"],
    ["https://shop.example.com/", "shop.example.com"],
    ["http://127.0.0.1:3000/app", "127.0.0.1:3000/app"],
    [null, "—"],
    ["not a url", "not a url"],
  ])("%s -> %s", (url, expected) => {
    expect(shortTarget(url)).toBe(expected);
  });
});

describe("pageCounts", () => {
  it("lists non-zero counts worst first", () => {
    expect(pageCounts({ fail: 1, review: 0, pass: 5 })).toBe("1 fail · 5 pass");
    expect(pageCounts({ fail: 0, review: 0, pass: 0 })).toBe("no pages");
  });
});

describe("parseHash / buildHash", () => {
  it("parses the route and its query", () => {
    const { path, params } = parseHash("#/runs?status=fail&page=2");
    expect(path).toBe("/runs");
    expect([params.get("status"), params.get("page")]).toEqual(["fail", "2"]);
  });

  it("defaults to the run list", () => {
    expect(parseHash("").path).toBe("/runs");
    expect(parseHash("#").path).toBe("/runs");
  });

  it("builds hashes, leaving out empty values and page 1", () => {
    expect(buildHash("/runs", { status: "fail", page: 2 })).toBe("#/runs?status=fail&page=2");
    expect(buildHash("/runs", { status: "", page: 1 })).toBe("#/runs");
    expect(buildHash("/runs", { status: undefined, page: 0 })).toBe("#/runs?page=0");
  });

  it("round-trips", () => {
    const hash = buildHash("/runs", { status: "review", page: 3 });
    const { path, params } = parseHash(hash);
    expect(buildHash(path, Object.fromEntries(params))).toBe(hash);
  });
});

describe("detail page helpers (P040)", () => {
  it.each([
    [0, "0%"],
    [0.001, "<0.01%"],
    [5, "5.00%"],
    [null, "—"],
  ])("formatPercent(%s) -> %s", (p, expected) => {
    expect(formatPercent(p)).toBe(expected);
  });

  it("formatCount adds thousands separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(null)).toBe("—");
  });

  const base = {
    compared: true,
    changed: true,
    verdict: null,
    confidence: null,
    judgeError: null,
    status: "review",
  };
  it.each([
    [{ ...base, compared: false }, "Not compared", "review"],
    [{ ...base, changed: false, status: "pass" }, "Unchanged", "pass"],
    [{ ...base, judgeError: "x" }, "Couldn't be judged", "review"],
    [{ ...base, verdict: "Real Bug", confidence: 9, status: "fail" }, "Real Bug (9/10)", "fail"],
    [base, "Changed (not judged)", "review"],
  ])("screenshotLabel %#", (shot, text, status) => {
    expect(screenshotLabel(shot)).toEqual({ text, status });
  });

  it("describeSizeChange", () => {
    const shot = {
      sizeChanged: true,
      baselineSize: { width: 390, height: 900 },
      currentSize: { width: 836, height: 844 },
    };
    expect(describeSizeChange(shot)).toBe("width 390px → 836px, height 900px → 844px");
    expect(describeSizeChange({ ...shot, sizeChanged: false })).toBe("");
  });
});
