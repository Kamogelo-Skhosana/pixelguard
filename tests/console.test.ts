/**
 * Tests for the console output formatter.
 *
 * Ticket: P016
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import {
  describeSizeChange,
  formatCount,
  formatDiffResults,
  formatPercent,
  printDiffResults,
} from "../src/report/console.js";

function result(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    page: "home",
    viewport: "desktop",
    pixelDiffCount: 0,
    totalPixels: 1000,
    percentChanged: 0,
    changed: false,
    sizeChanged: false,
    baselineSize: { width: 100, height: 10 },
    currentSize: { width: 100, height: 10 },
    diffImagePath: "diffs/desktop/home.png",
    baselineImagePath: "screenshots/baseline/desktop/home.png",
    currentImagePath: "screenshots/current/desktop/home.png",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatPercent", () => {
  it.each([
    [0, "0%"],
    [0.0001, "<0.01%"],
    [0.009, "<0.01%"],
    [0.01, "0.01%"],
    [1.25, "1.25%"],
    [12.3456, "12.35%"],
    [100, "100.00%"],
  ])("%f -> %s", (input, expected) => {
    expect(formatPercent(input)).toBe(expected);
  });
});

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [4820, "4,820"],
    [1234567, "1,234,567"],
  ])("%i -> %s", (input, expected) => {
    expect(formatCount(input)).toBe(expected);
  });
});

describe("describeSizeChange", () => {
  it("is empty when the size didn't change", () => {
    expect(describeSizeChange(result())).toBe("");
  });

  it("describes height and width changes", () => {
    const r = result({
      sizeChanged: true,
      baselineSize: { width: 1440, height: 2000 },
      currentSize: { width: 1400, height: 2300 },
    });
    expect(describeSizeChange(r)).toBe("width 1440px -> 1400px, height 2000px -> 2300px");
  });
});

describe("formatDiffResults", () => {
  const results = [
    result({ pixelDiffCount: 4820, percentChanged: 1.25, changed: true }),
    result({ viewport: "mobile" }),
    result({
      page: "about",
      pixelDiffCount: 86400,
      percentChanged: 20,
      changed: true,
      sizeChanged: true,
      baselineSize: { width: 1440, height: 2000 },
      currentSize: { width: 1440, height: 2300 },
    }),
  ];

  it("renders an aligned table and summary without colour", () => {
    expect(formatDiffResults(results, { colour: false })).toBe(
      [
        "Page   Viewport  Changed  Pixels  Status     Notes",
        "home   desktop     1.25%   4,820  CHANGED",
        "home   mobile         0%       0  unchanged",
        "about  desktop    20.00%  86,400  CHANGED    height 2000px -> 2300px",
        "",
        "2 of 3 screenshots changed. Biggest change: about / desktop (20.00%)",
      ].join("\n")
    );
  });

  it("reports when nothing changed", () => {
    const out = formatDiffResults([result()], { colour: false });
    expect(out.split("\n").at(-1)).toBe("0 of 1 screenshot changed.");
  });

  it("handles an empty list", () => {
    expect(formatDiffResults([], { colour: false })).toBe("No screenshots to compare.");
  });

  it("adds colour codes without breaking alignment", () => {
    const coloured = formatDiffResults(results, { colour: true });
    expect(coloured).toContain("\x1b[31mCHANGED");
    expect(coloured).toContain("\x1b[32munchanged");
    // eslint-disable-next-line no-control-regex
    const stripped = coloured.replace(/\x1b\[\d+m/g, "");
    expect(stripped).toBe(formatDiffResults(results, { colour: false }));
  });
});

describe("verdict column (P024)", () => {
  const judged = [
    result({
      pixelDiffCount: 4820,
      percentChanged: 1.25,
      changed: true,
      verdict: "Real Bug",
      confidence: 8,
      explanation: "x",
    }),
    result({
      viewport: "mobile",
      pixelDiffCount: 10,
      percentChanged: 0.5,
      changed: true,
      verdict: "Uncertain",
      explanation: "Could not be judged automatically: timeout",
      judgeError: "timeout",
    }),
    result({ page: "about" }),
  ];

  it("shows verdicts once results are judged", () => {
    expect(formatDiffResults(judged, { colour: false }).split("\n").slice(0, 4)).toEqual([
      "Page   Viewport  Changed  Pixels  Status     Verdict                 Notes",
      "home   desktop     1.25%   4,820  CHANGED    Real Bug (8/10)",
      "home   mobile      0.50%      10  CHANGED    Uncertain (not judged)",
      "about  desktop        0%       0  unchanged",
    ]);
  });

  it("colours verdicts", () => {
    const out = formatDiffResults(judged, { colour: true });
    expect(out).toContain("\x1b[31mReal Bug (8/10)");
    expect(out).toContain("\x1b[33mUncertain (not judged)");
  });

  it("has no verdict column before judging", () => {
    expect(formatDiffResults([result()], { colour: false })).not.toContain("Verdict");
  });
});

describe("printDiffResults", () => {
  it("writes the formatted report to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printDiffResults([result()], { colour: false });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("0 of 1 screenshot changed.");
  });
});
