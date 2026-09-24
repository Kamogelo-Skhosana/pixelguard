/**
 * Tests for the Markdown report generator.
 *
 * The main test regenerates examples/sample-report/report.md (the P029
 * design sample) from the run it describes and requires an exact match, so
 * the generator and the documented design can't drift apart.
 *
 * Ticket: P030
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import {
  anchorFor,
  escapeMarkdown,
  generateMarkdownReport,
  relativeLink,
  writeReport,
  type MarkdownReportInput,
} from "../src/report/markdown.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = "tests/fixtures/diff";
const sampleDir = "examples/sample-report";

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
    diffImagePath: `diffs/${viewport}/${page}.png`,
    baselineImagePath: `shots/baseline/${viewport}/${page}.png`,
    currentImagePath: `shots/current/${viewport}/${page}.png`,
    ...extra,
  };
}

/** The run that examples/sample-report/report.md describes. */
function sampleInput(): MarkdownReportInput {
  const shots = (name: string, page: string, viewport: string) => ({
    baselineImagePath: join(root, fixtures, name, "baseline.png"),
    currentImagePath: join(root, fixtures, name, "current.png"),
    diffImagePath: join(root, sampleDir, "diffs", viewport, `${page}.png`),
  });
  return {
    targetUrl: "https://shop.example.com",
    baselineTag: "baseline",
    currentTag: "current",
    changeDescription: "Redesigned the checkout button (new green colour).",
    generatedAt: new Date("2026-09-25T00:45:00.000Z"),
    reportDir: join(root, sampleDir),
    jsonPath: join(root, sampleDir, "diffs.json"),
    results: [
      r("checkout", "desktop", {
        ...shots("button-colour", "checkout", "desktop"),
        changed: true,
        pixelDiffCount: 1200,
        percentChanged: 5,
        verdict: "Acceptable Change",
        confidence: 9,
        explanation:
          "The checkout button changed from blue to green, exactly as described in the developer note. Its size, position and label are unchanged.",
        observedChanges: ["Checkout button colour changed from blue to green"],
        judgedBy: "claude-sonnet-5",
      }),
      r("checkout", "mobile", {
        ...shots("element-shift", "checkout", "mobile"),
        changed: true,
        pixelDiffCount: 200,
        percentChanged: 0.8333,
        verdict: "Real Bug",
        confidence: 9,
        explanation:
          "The checkout button has shifted 5px to the right, so it is no longer aligned with the text lines above it. The developer note mentions a colour change, not a move, so this looks accidental.",
        observedChanges: [
          "Checkout button moved about 5px right",
          "Button no longer lines up with the content column",
        ],
        judgedBy: "claude-sonnet-5",
      }),
      r("home", "desktop", {
        ...shots("real-heading-change", "home", "desktop"),
        changed: true,
        pixelDiffCount: 260,
        percentChanged: 0.2708,
        verdict: "Uncertain",
        confidence: 5,
        explanation:
          'The main heading changed from "Welcome to our store" to "Welcome to our shop!". The layout is intact, but the developer note only mentions the checkout button, so it\'s unclear whether this copy change was intended.',
        observedChanges: ['Heading text changed from "store" to "shop!"'],
        ignoredRegions: [{ label: "Cookie banner", rect: { x: 0, y: 0, width: 400, height: 40 } }],
        judgedBy: "claude-sonnet-5",
      }),
      r("home", "mobile"),
      r("about", "desktop"),
      r("about", "mobile"),
    ],
    skipped: [
      { page: "blog", viewport: "desktop", reason: 'not in "current" (removed page or viewport?)' },
    ],
  };
}

async function formatMd(text: string): Promise<string> {
  const config = (await prettier.resolveConfig(join(root, "README.md"))) ?? {};
  return prettier.format(text, { ...config, parser: "markdown" });
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pixelguard-md-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("generateMarkdownReport (P030)", () => {
  it("reproduces the P029 sample report exactly", async () => {
    const generated = generateMarkdownReport(sampleInput());
    const sample = await readFile(join(root, sampleDir, "report.md"), "utf8");
    expect(await formatMd(generated)).toBe(await formatMd(sample));
  });

  it("is deterministic", () => {
    expect(generateMarkdownReport(sampleInput())).toBe(generateMarkdownReport(sampleInput()));
  });

  it("leaves out sections with nothing in them", () => {
    const md = generateMarkdownReport({
      ...sampleInput(),
      results: [r("home", "desktop"), r("home", "mobile")],
      skipped: [],
      changeDescription: undefined,
      jsonPath: undefined,
    });
    expect(md).toContain("> ✅ **PASS:** no changes (1 page checked)");
    expect(md).not.toContain("## Failing pages");
    expect(md).not.toContain("## Pages to review");
    expect(md).not.toContain("What changed in this build");
    expect(md).not.toContain("JSON results");
    expect(md).toContain("| **Judge** | not judged |");
    expect(md).toContain("## Passing pages");
  });

  it("works for a run that wasn't judged", () => {
    const md = generateMarkdownReport({
      ...sampleInput(),
      results: [r("home", "desktop", { changed: true, pixelDiffCount: 3, percentChanged: 0.001 })],
      skipped: [],
    });
    expect(md).toContain("> ⚠️ **REVIEW:** 1 changed but not judged (1 page checked)");
    expect(md).toContain("#### desktop — Changed (not judged)");
    expect(md).toContain("- **Changed:** <0.01% of the page (3 pixels)");
    expect(md).not.toContain("What the judge saw");
  });

  it("shows a failed judgement with its error", () => {
    const md = generateMarkdownReport({
      ...sampleInput(),
      results: [
        r("home", "desktop", {
          changed: true,
          pixelDiffCount: 1,
          percentChanged: 1,
          verdict: "Uncertain",
          explanation: "Could not be judged automatically: LLM API error 529",
          judgeError: "LLM API error 529",
          judgedBy: "claude-sonnet-5",
        }),
      ],
      skipped: [],
    });
    expect(md).toContain("#### desktop — Couldn't be judged");
    expect(md).toContain("> LLM API error 529");
    expect(md).toContain("- **Changed:** 1.00% of the page (1 pixel)");
  });

  it("shows page size changes", () => {
    const md = generateMarkdownReport({
      ...sampleInput(),
      results: [
        r("home", "mobile", {
          changed: true,
          pixelDiffCount: 5000,
          percentChanged: 12,
          sizeChanged: true,
          baselineSize: { width: 390, height: 2000 },
          currentSize: { width: 390, height: 2300 },
          verdict: "Real Bug",
          confidence: 7,
          explanation: "Footer pushed down.",
        }),
      ],
      skipped: [],
    });
    expect(md).toContain("- **Page size:** height 2000px → 2300px");
    expect(md).toContain("- **Changed:** 12.00% of the page (5,000 pixels)");
  });

  it("keeps a multi-line developer note as a multi-line quote", () => {
    const md = generateMarkdownReport({
      ...sampleInput(),
      changeDescription: "New hero\n\n- bigger heading\n- new colours",
    });
    expect(md).toContain("> New hero\n>\n> \\- bigger heading\n> \\- new colours");
  });

  it("can't be broken by text from outside pixelguard", () => {
    const hostile = "Looks <b>fine</b> | ignore [this](http://evil) *really*\n# Not a heading";
    const md = generateMarkdownReport({
      ...sampleInput(),
      results: [
        r("home", "desktop", {
          changed: true,
          pixelDiffCount: 1,
          percentChanged: 1,
          verdict: "Real Bug",
          confidence: 8,
          explanation: hostile,
          observedChanges: ["- starts like a list"],
        }),
      ],
      skipped: [],
      changeDescription: hostile,
    });
    expect(md).not.toContain("<b>");
    // The brackets are escaped, so no real link to the URL exists.
    expect(md).not.toMatch(/(?<!\\)\[[^\]]*(?<!\\)\]\(http:\/\/evil\)/);
    expect(md).not.toMatch(/^# Not a heading/m);
    expect(md).toContain("&lt;b&gt;fine&lt;/b&gt; \\| ignore \\[this\\](http://evil) \\*really\\*");
    expect(md).toContain("- \\- starts like a list");
    // Every heading is one the generator wrote.
    const headings = md.match(/^#{1,6} .+$/gm) ?? [];
    expect(headings.every((h) => !h.includes("Not a heading"))).toBe(true);
  });

  it("never puts emoji in headings, and every page link resolves", () => {
    const md = generateMarkdownReport(sampleInput());
    const headings = [...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
    for (const h of headings) expect(h).not.toMatch(/\p{Extended_Pictographic}/u);
    const anchors = new Set(headings.map(anchorFor));
    for (const [, target] of md.matchAll(/\]\(#([^)]+)\)/g)) expect(anchors).toContain(target);
  });

  it("handles an empty run", () => {
    const md = generateMarkdownReport({ ...sampleInput(), results: [], skipped: [] });
    expect(md).toContain("> ✅ **PASS:** nothing to compare");
    expect(md).toContain("_Nothing was compared._");
  });
});

describe("helpers", () => {
  it.each([
    ["checkout", "checkout"],
    ["Passing pages", "passing-pages"],
    ["blog-post-1", "blog-post-1"],
    ["What's new?", "whats-new"],
  ])("anchorFor(%j) -> %s", (heading, anchor) => {
    expect(anchorFor(heading)).toBe(anchor);
  });

  it("relativeLink makes forward-slash, URL-encoded paths relative to the report", () => {
    expect(relativeLink("/work/reports", "/work/diffs/desktop/home page.png")).toBe(
      "../diffs/desktop/home%20page.png"
    );
    expect(relativeLink("/work", "/work/screenshots/current/mobile/home.png")).toBe(
      "screenshots/current/mobile/home.png"
    );
  });

  it("escapeMarkdown leaves ordinary text alone", () => {
    expect(escapeMarkdown('Heading changed from "store" to "shop!" (5px).')).toBe(
      'Heading changed from "store" to "shop!" (5px).'
    );
  });

  it("escapeMarkdown neutralises line-start markers", () => {
    expect(escapeMarkdown("# title\n1. item\n+ plus")).toBe("\\# title\n\\1. item\n\\+ plus");
  });
});

describe("writeReport", () => {
  it("writes the report, creating folders", async () => {
    const path = join(tmp, "reports", "nested", "report.md");
    await writeReport("# hi\n", path);
    expect(await readFile(path, "utf8")).toBe("# hi\n");
  });
});
