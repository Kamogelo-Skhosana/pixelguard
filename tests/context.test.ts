/**
 * Tests for the change-context schema.
 *
 * Ticket: P018
 */

import { describe, expect, it } from "vitest";
import {
  ChangeContextError,
  describeRegions,
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
