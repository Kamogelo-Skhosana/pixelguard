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

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");

let root: string;
let outputDir: string;
let diffDir: string;

/** Writes a capture: pages -> viewport -> fixture image to copy in (or an error string). */
async function writeCapture(
  tag: string,
  pages: Record<string, Record<string, string | { error: string }>>
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
      if (typeof source === "string") {
        const file = `${viewport}/${name}.png`;
        await mkdir(join(outputDir, tag, viewport), { recursive: true });
        await copyFile(join(fixtures, source), join(outputDir, tag, file));
        screenshots.push({ viewport, ok: true, file, width: 0, height: 0 });
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
