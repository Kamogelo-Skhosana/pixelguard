/**
 * Tests for the change-context schema.
 *
 * Ticket: P018
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChangeContextError,
  describeRegions,
  loadDynamicRegions,
  MAX_CHANGE_DESCRIPTION_LENGTH,
  normalizeChangeDescription,
  parseDynamicRegions,
  regionMatches,
  regionsFor,
  type ChangeContext,
  type DynamicRegion,
} from "../src/judge/context.js";

const footerYear = {
  page: "/",
  label: "Footer year",
  kind: "timestamp",
  selector: "#copyright",
  handling: "ignore",
};
const cookieBanner = {
  page: "*",
  viewport: "mobile",
  label: "Cookie banner",
  kind: "banner",
  rect: { x: 0, y: 0, width: 390, height: 80 },
  handling: "ignore",
};
const carousel = { page: "home", label: "Hero carousel", kind: "carousel", selector: ".hero" };

describe("parseDynamicRegions", () => {
  it("accepts selector and rect regions and applies defaults", () => {
    const regions = parseDynamicRegions({ regions: [footerYear, cookieBanner, carousel] });
    expect(regions).toEqual([
      { ...footerYear, viewport: "*" },
      cookieBanner,
      { ...carousel, viewport: "*", handling: "inform" },
    ]);
  });

  it("defaults kind to other", () => {
    const [r] = parseDynamicRegions({ regions: [{ page: "/", label: "x", selector: ".x" }] });
    expect(r.kind).toBe("other");
  });

  it("treats a missing regions list as empty", () => {
    expect(parseDynamicRegions({})).toEqual([]);
  });

  it("requires exactly one of selector or rect", () => {
    expect(() => parseDynamicRegions({ regions: [{ page: "/", label: "x" }] })).toThrow(
      /regions\[0\]: needs exactly one of "selector" or "rect"/
    );
    expect(() =>
      parseDynamicRegions({
        regions: [{ ...footerYear, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      })
    ).toThrow(/exactly one/);
  });

  it("reports every problem with its location", () => {
    try {
      parseDynamicRegions(
        {
          regions: [
            { page: "", label: "x", selector: ".x" },
            { ...cookieBanner, rect: { x: -1, y: 0, width: 0, height: 10 } },
            { ...footerYear, kind: "weather", handling: "hide" },
          ],
        },
        "pixelguard.regions.json"
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChangeContextError);
      const e = err as ChangeContextError;
      expect(e.message).toContain("Invalid pixelguard.regions.json");
      expect(e.issues.some((i) => i.startsWith("regions[0].page:"))).toBe(true);
      expect(e.issues.some((i) => i.startsWith("regions[1].rect.x:"))).toBe(true);
      expect(e.issues.some((i) => i.startsWith("regions[1].rect.width:"))).toBe(true);
      expect(e.issues.some((i) => i.startsWith("regions[2].kind:"))).toBe(true);
      expect(e.issues.some((i) => i.startsWith("regions[2].handling:"))).toBe(true);
    }
  });

  it("rejects unknown fields so typos don't go unnoticed", () => {
    expect(() => parseDynamicRegions({ regions: [{ ...footerYear, selecter: ".y" }] })).toThrow(
      /regions\[0\]/
    );
    expect(() => parseDynamicRegions({ region: [] })).toThrow(ChangeContextError);
  });

  it("rejects input that isn't an object", () => {
    expect(() => parseDynamicRegions("nope")).toThrow(ChangeContextError);
    expect(() => parseDynamicRegions({ regions: "nope" })).toThrow(/regions:/);
  });
});

describe("regionMatches", () => {
  const [footer, banner] = parseDynamicRegions({ regions: [footerYear, cookieBanner] });

  it("matches a page by path or by name", () => {
    expect(regionMatches(footer, "home", "desktop")).toBe(true);
    expect(regionMatches(footer, "/", "desktop")).toBe(true);
    expect(regionMatches(footer, "about", "desktop")).toBe(false);
  });

  it("supports * for every page and a specific viewport (case-insensitive)", () => {
    expect(regionMatches(banner, "about", "mobile")).toBe(true);
    expect(regionMatches(banner, "checkout", "Mobile")).toBe(true);
    expect(regionMatches(banner, "about", "desktop")).toBe(false);
  });
});

describe("regionsFor", () => {
  const context: ChangeContext = {
    dynamicRegions: parseDynamicRegions({ regions: [footerYear, cookieBanner, carousel] }),
    changeDescription: "",
  };

  it("splits the matching regions into ignore and inform", () => {
    const mobileHome = regionsFor(context, "home", "mobile");
    expect(mobileHome.ignore.map((r) => r.label)).toEqual(["Footer year", "Cookie banner"]);
    expect(mobileHome.inform.map((r) => r.label)).toEqual(["Hero carousel"]);

    const desktopAbout = regionsFor(context, "about", "desktop");
    expect(desktopAbout).toEqual({ ignore: [], inform: [] });
  });
});

describe("describeRegions", () => {
  it("says none when there are no regions", () => {
    expect(describeRegions([])).toBe("none");
  });

  it("describes selector and rect regions and their handling", () => {
    const regions: DynamicRegion[] = parseDynamicRegions({
      regions: [footerYear, cookieBanner, carousel],
    });
    expect(describeRegions(regions)).toBe(
      [
        '- Footer year (timestamp) at element "#copyright": excluded from the pixel diff',
        "- Cookie banner (banner) at area x=0, y=0, 390x80px: excluded from the pixel diff",
        '- Hero carousel (carousel) at element ".hero": expected to change; differences here are likely acceptable',
      ].join("\n")
    );
  });
});

describe("loadDynamicRegions (P019)", () => {
  it("loads and validates a regions file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixelguard-regions-"));
    try {
      const path = join(dir, "pixelguard.regions.json");
      await writeFile(path, JSON.stringify({ regions: [footerYear, carousel] }));
      const regions = await loadDynamicRegions(path);
      expect(regions.map((r) => r.label)).toEqual(["Footer year", "Hero carousel"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no regions when the default file doesn't exist", async () => {
    expect(await loadDynamicRegions(join(tmpdir(), "no-such-regions.json"))).toEqual([]);
  });

  it("errors when a required file doesn't exist", async () => {
    await expect(
      loadDynamicRegions(join(tmpdir(), "no-such-regions.json"), { required: true })
    ).rejects.toThrow(/no-such-regions\.json[\s\S]*could not read the file/);
  });

  it("explains invalid JSON and schema problems, naming the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixelguard-regions-"));
    try {
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{ regions: [ }");
      await expect(loadDynamicRegions(bad)).rejects.toThrow(/bad\.json[\s\S]*not valid JSON/);

      const wrong = join(dir, "wrong.json");
      await writeFile(wrong, JSON.stringify({ regions: [{ page: "/", label: "x" }] }));
      await expect(loadDynamicRegions(wrong)).rejects.toThrow(
        /wrong\.json[\s\S]*regions\[0\]: needs exactly one/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the example regions file in the repo is valid", async () => {
    const regions = await loadDynamicRegions("pixelguard.regions.example.json", { required: true });
    expect(regions.length).toBeGreaterThan(0);
  });
});

describe("normalizeChangeDescription (P020)", () => {
  it("returns an empty string for no description", () => {
    expect(normalizeChangeDescription(undefined)).toBe("");
    expect(normalizeChangeDescription("   \n  ")).toBe("");
  });

  it("trims, normalises line endings and collapses blank lines", () => {
    expect(
      normalizeChangeDescription("  Redesigned checkout  \r\n\r\n\r\n\r\n- new button   \r\n")
    ).toBe("Redesigned checkout\n\n- new button");
  });

  it("rejects descriptions that are too long", () => {
    const long = "x".repeat(MAX_CHANGE_DESCRIPTION_LENGTH + 1);
    expect(() => normalizeChangeDescription(long)).toThrow(/keep it under 1000/);
    expect(normalizeChangeDescription("x".repeat(MAX_CHANGE_DESCRIPTION_LENGTH))).toHaveLength(
      MAX_CHANGE_DESCRIPTION_LENGTH
    );
  });
});
