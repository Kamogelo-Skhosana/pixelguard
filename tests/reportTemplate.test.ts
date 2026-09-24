/**
 * Keeps the report design docs honest: the sample report's links and
 * images must exist, and its summary text must match what the rollup code
 * produces for the same run.
 *
 * Ticket: P029
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { rollupPages, summarizeRun } from "../src/judge/aggregate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplePath = join(root, "examples", "sample-report", "report.md");
const sample = readFileSync(samplePath, "utf8");

/** The run the sample report describes. */
function sampleRun() {
  const base = {
    totalPixels: 100,
    sizeChanged: false,
    baselineSize: { width: 1, height: 1 },
    currentSize: { width: 1, height: 1 },
    diffImagePath: "",
    baselineImagePath: "",
    currentImagePath: "",
  };
  const changed = (page: string, viewport: string, verdict: Verdict, confidence: number) => ({
    ...base,
    page,
    viewport,
    changed: true,
    pixelDiffCount: 5,
    percentChanged: 1,
    verdict,
    confidence,
    explanation: "x",
  });
  const same = (page: string, viewport: string) => ({
    ...base,
    page,
    viewport,
    changed: false,
    pixelDiffCount: 0,
    percentChanged: 0,
  });
  const results: DiffResult[] = [
    changed("checkout", "desktop", "Acceptable Change", 9),
    changed("checkout", "mobile", "Real Bug", 9),
    changed("home", "desktop", "Uncertain", 5),
    same("home", "mobile"),
    same("about", "desktop"),
    same("about", "mobile"),
  ];
  const skipped = [
    { page: "blog", viewport: "desktop", reason: 'not in "current" (removed page or viewport?)' },
  ];
  return { results, skipped };
}

describe("sample report (P029)", () => {
  it("every image and file link points to a file that exists", () => {
    const links = [
      ...sample.matchAll(/src="([^"]+)"/g),
      ...sample.matchAll(/\]\(((?!#|https?:)[^)]+)\)/g),
    ].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(dirname(samplePath), decodeURIComponent(link));
      expect(existsSync(target), `${link} is missing`).toBe(true);
    }
  });

  it("every page link has a matching heading or section", () => {
    const anchors = [...sample.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    // Same slug rules as GitHub: lowercase, drop punctuation/emoji, each space -> "-".
    const headings = [...sample.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[^\w\s-]/gu, "")
        .replace(/ /g, "-")
    );
    for (const anchor of anchors) expect(headings, `#${anchor}`).toContain(anchor);
  });

  it("its banner matches summarizeRun() for the same run", () => {
    const { results, skipped } = sampleRun();
    const { headline } = summarizeRun(results, skipped);
    const [status, rest] = headline.split(/:(.*)/s);
    expect(sample).toContain(`> ❌ **${status}:**${rest}`);
  });

  it("its page summaries match rollupPages() for the same run", () => {
    const { results, skipped } = sampleRun();
    for (const page of rollupPages(results, skipped)) {
      expect(sample).toContain(page.summary);
    }
  });

  it("has no emoji in headings (they break GitHub anchors)", () => {
    const headings = [...sample.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
    for (const h of headings) expect(h, h).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the design doc links to the sample", () => {
    const design = readFileSync(join(root, "docs", "REPORT_TEMPLATE.md"), "utf8");
    expect(design).toContain("examples/sample-report/report.md");
  });
});
