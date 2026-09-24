/**
 * Tests for diffing a whole baseline capture against a current capture.
 *
 * Ticket: P015
 */

import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestScreenshot } from "../src/capture/storage.js";
import { diffTags } from "../src/diff/runDiff.js";
import { parseDynamicRegions, type ResolvedRegion } from "../src/judge/context.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");

let root: string;
let outputDir: string;
let diffDir: string;

/** Writes a capture: pages -> viewport -> fixture image to copy in (or an error string). */
async function writeCapture(
  tag: string,
  pages: Record<
    string,
    Record<string, string | { error: string } | { image: string; regions: ResolvedRegion[] }>
  >
): Promise<void> {
  const manifest: CaptureManifest = {
    tag,
    capturedAt: "2026-09-24T12:00:00.000Z",
    baseUrl: "http://example.test",
    viewports: [],
    pages: [],
  };
  for (const [name, shots] of Object.entries(pages)) {
    const screenshots: ManifestScreenshot[] = [];
    for (const [viewport, source] of Object.entries(shots)) {
      if (typeof source === "string" || "image" in source) {
        const image = typeof source === "string" ? source : source.image;
        const file = `${viewport}/${name}.png`;
        await mkdir(join(outputDir, tag, viewport), { recursive: true });
        await copyFile(join(fixtures, image), join(outputDir, tag, file));
        screenshots.push({
          viewport,
          ok: true,
          file,
          width: 0,
          height: 0,
          ...(typeof source !== "string" && { regions: source.regions }),
        });
      } else {
        screenshots.push({ viewport, ok: false, error: source.error });
      }
    }
    manifest.pages.push({
      page: `/${name}`,
      name,
      url: `http://example.test/${name}`,
      screenshots,
    });
  }
  await mkdir(join(outputDir, tag), { recursive: true });
  await writeFile(join(outputDir, tag, "manifest.json"), JSON.stringify(manifest));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelguard-rundiff-"));
  outputDir = join(root, "screenshots");
  diffDir = join(root, "diffs");

  await writeCapture("baseline", {
    home: { desktop: "button-colour/baseline.png", mobile: "identical/baseline.png" },
    about: { desktop: "identical/baseline.png" },
    old: { desktop: "identical/baseline.png" },
    broken: { desktop: { error: "HTTP 500" } },
  });
  await writeCapture("current", {
    home: { desktop: "button-colour/current.png", mobile: "identical/current.png" },
    about: { desktop: "identical/current.png", tablet: "identical/current.png" },
    broken: { desktop: "identical/current.png" },
    fresh: { desktop: "identical/current.png" },
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("diffTags", () => {
  it("diffs every page/viewport captured in both tags", async () => {
    const run = await diffTags({
      outputDir,
      diffDir,
      baselineTag: "baseline",
      currentTag: "current",
    });

    expect(run.dir).toBe(join(diffDir, "baseline-vs-current"));
    expect(run.targetUrl).toBe("http://example.test");
    expect(run.results.map((r) => [r.page, r.viewport, r.changed, r.pixelDiffCount])).toEqual([
      ["home", "desktop", true, 1200],
      ["home", "mobile", false, 0],
      ["about", "desktop", false, 0],
    ]);
    await expect(
      access(join(diffDir, "baseline-vs-current", "desktop", "home.png"))
    ).resolves.toBeUndefined();
  });

  it("lists everything it couldn't compare, with a reason", async () => {
    const run = await diffTags({
      outputDir,
      diffDir,
      baselineTag: "baseline",
      currentTag: "current",
    });
    expect(run.skipped).toEqual([
      { page: "about", viewport: "tablet", reason: expect.stringMatching(/not in "baseline"/) },
      { page: "old", viewport: "desktop", reason: expect.stringMatching(/not in "current"/) },
      {
        page: "broken",
        viewport: "desktop",
        reason: 'failed in "baseline": HTTP 500',
      },
      { page: "fresh", viewport: "desktop", reason: expect.stringMatching(/not in "baseline"/) },
    ]);
  });

  it("reports progress for each result", async () => {
    const seen: string[] = [];
    await diffTags({
      outputDir,
      diffDir,
      baselineTag: "baseline",
      currentTag: "current",
      onResult: (r) => seen.push(`${r.page}/${r.viewport}`),
    });
    expect(seen).toEqual(["home/desktop", "home/mobile", "about/desktop"]);
  });

  it("passes compare options through", async () => {
    const run = await diffTags({
      outputDir,
      diffDir,
      baselineTag: "baseline",
      currentTag: "current",
      compare: { threshold: 1 },
    });
    expect(run.results.every((r) => !r.changed)).toBe(true);
  });

  it("clears diff images from an earlier run", async () => {
    const stale = join(diffDir, "baseline-vs-current", "desktop", "stale.png");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "old");
    await diffTags({ outputDir, diffDir, baselineTag: "baseline", currentTag: "current" });
    await expect(access(stale)).rejects.toThrow();
  });

  it("explains a missing capture", async () => {
    await expect(
      diffTags({ outputDir, diffDir, baselineTag: "baseline", currentTag: "nope" })
    ).rejects.toThrow(/No capture found for tag "nope"/);
  });

  it("rejects comparing a tag with itself, and invalid tags", async () => {
    await expect(
      diffTags({ outputDir, diffDir, baselineTag: "baseline", currentTag: "baseline" })
    ).rejects.toThrow(/are the same/);
    await expect(
      diffTags({ outputDir, diffDir, baselineTag: "../x", currentTag: "current" })
    ).rejects.toThrow(/Invalid tag/);
  });
});

describe("diffTags with known dynamic regions (P019)", () => {
  // In the button-colour fixture the button is at x=20, y=60, 60x20.
  const button = { x: 20, y: 60, width: 60, height: 20 };
  const measuredButton: ResolvedRegion = {
    label: "Promo button",
    kind: "ad",
    handling: "ignore",
    selector: ".promo",
    rects: [button],
  };

  beforeAll(async () => {
    await writeCapture("r-base", {
      home: { desktop: { image: "button-colour/baseline.png", regions: [measuredButton] } },
    });
    await writeCapture("r-curr", {
      home: { desktop: { image: "button-colour/current.png", regions: [measuredButton] } },
    });
  });

  const run = (regions: unknown[]) =>
    diffTags({
      outputDir,
      diffDir,
      baselineTag: "r-base",
      currentTag: "r-curr",
      regions: parseDynamicRegions({ regions }),
    });

  it("masks an ignore rect region so the change disappears", async () => {
    const r = await run([{ page: "/", label: "Button area", rect: button, handling: "ignore" }]);
    expect(r.results[0]).toMatchObject({
      changed: false,
      pixelDiffCount: 0,
      ignoredRegions: [{ label: "Button area", rect: button }],
    });
  });

  it("masks an ignore selector region using the boxes measured at capture", async () => {
    const r = await run([
      { page: "home", label: "Promo button", selector: ".promo", handling: "ignore" },
    ]);
    expect(r.results[0].changed).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("keeps inform regions in the diff and passes them on for the judge", async () => {
    const r = await run([
      { page: "*", label: "Promo button", kind: "ad", selector: ".promo", handling: "inform" },
    ]);
    expect(r.results[0]).toMatchObject({
      changed: true,
      pixelDiffCount: 1200,
      expectedChangeRegions: [{ label: "Promo button", kind: "ad", rect: button }],
    });
    expect(r.results[0].ignoredRegions).toBeUndefined();
  });

  it("only masks the part of the change the region covers", async () => {
    const half = { x: 20, y: 60, width: 30, height: 20 };
    const r = await run([{ page: "/", label: "Half", rect: half, handling: "ignore" }]);
    expect(r.results[0].pixelDiffCount).toBe(600);
  });

  it("ignores regions for other pages or viewports", async () => {
    const r = await run([
      { page: "/about", label: "Other page", rect: button, handling: "ignore" },
      { page: "*", viewport: "mobile", label: "Other viewport", rect: button, handling: "ignore" },
    ]);
    expect(r.results[0].pixelDiffCount).toBe(1200);
  });

  it("warns about selector regions that were never measured", async () => {
    const r = await run([{ page: "/", label: "New banner", selector: ".new", handling: "ignore" }]);
    expect(r.results[0].changed).toBe(true);
    expect(r.warnings).toEqual([
      expect.stringMatching(/Region "New banner" on home \/ desktop wasn't measured.*re-capture/),
    ]);
  });
});
