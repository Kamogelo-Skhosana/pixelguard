/**
 * Tests for configuration loading.
 *
 * Ticket: P011
 */

import { describe, it, expect } from "vitest";
import {
  ConfigError,
  DEFAULT_VIEWPORTS,
  loadSettings,
  parsePages,
  parseViewports,
  sqlitePathFromUrl,
} from "../src/config.js";

describe("sqlitePathFromUrl", () => {
  it("strips the sqlite: prefix from a relative path", () => {
    expect(sqlitePathFromUrl("sqlite:./pixelguard.db")).toBe("./pixelguard.db");
  });

  it("handles sqlite:// with an absolute path", () => {
    expect(sqlitePathFromUrl("sqlite:///data/pixelguard.db")).toBe("/data/pixelguard.db");
  });

  it("returns plain paths unchanged", () => {
    expect(sqlitePathFromUrl("./pixelguard.db")).toBe("./pixelguard.db");
  });
});

describe("parsePages", () => {
  it("trims, adds a leading slash, and drops blanks and duplicates", () => {
    expect(parsePages(" /, search ,/checkout,, /search")).toEqual(["/", "/search", "/checkout"]);
  });
});

describe("parseViewports", () => {
  it("parses name:WIDTHxHEIGHT entries", () => {
    expect(parseViewports("Desktop:1280x800, mobile:375x667")).toEqual([
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile", width: 375, height: 667 },
    ]);
  });

  it("rejects malformed entries", () => {
    expect(() => parseViewports("desktop-1280x800")).toThrow(/name:WIDTHxHEIGHT/);
  });

  it("rejects zero sizes", () => {
    expect(() => parseViewports("tiny:0x100")).toThrow(/above 0/);
  });

  it("rejects duplicate names", () => {
    expect(() => parseViewports("a:1x1,a:2x2")).toThrow(/more than once/);
  });
});

describe("loadSettings", () => {
  it("applies defaults when only TARGET_BASE_URL is set", () => {
    const s = loadSettings({ TARGET_BASE_URL: "http://localhost:3000/" });
    expect(s).toEqual({
      targetBaseUrl: "http://localhost:3000",
      targetPages: ["/"],
      viewports: DEFAULT_VIEWPORTS,
      outputDir: "screenshots",
      llmApiKey: "",
      llmModel: "claude-sonnet-4-6",
      databaseUrl: "sqlite:./pixelguard.db",
      databasePath: "./pixelguard.db",
    });
  });

  it("reads every supported variable", () => {
    const s = loadSettings({
      TARGET_BASE_URL: "https://example.com",
      TARGET_PAGES: "/,/about",
      VIEWPORTS: "wide:1920x1080",
      OUTPUT_DIR: "shots",
      LLM_API_KEY: "key",
      LLM_MODEL: "some-model",
      DATABASE_URL: "sqlite:./runs.db",
    });
    expect(s.targetPages).toEqual(["/", "/about"]);
    expect(s.viewports).toEqual([{ name: "wide", width: 1920, height: 1080 }]);
    expect(s.outputDir).toBe("shots");
    expect(s.llmApiKey).toBe("key");
    expect(s.llmModel).toBe("some-model");
    expect(s.databasePath).toBe("./runs.db");
  });

  it("treats blank values as unset", () => {
    const s = loadSettings({ TARGET_BASE_URL: "http://localhost:3000", OUTPUT_DIR: "  " });
    expect(s.outputDir).toBe("screenshots");
  });

  it("throws a ConfigError pointing at .env.example when TARGET_BASE_URL is missing", () => {
    expect(() => loadSettings({})).toThrow(ConfigError);
    expect(() => loadSettings({})).toThrow(/TARGET_BASE_URL is required[\s\S]*\.env\.example/);
  });

  it("rejects non-http URLs", () => {
    expect(() => loadSettings({ TARGET_BASE_URL: "ftp://example.com" })).toThrow(/http/);
    expect(() => loadSettings({ TARGET_BASE_URL: "localhost:3000" })).toThrow(ConfigError);
  });

  it("reports every problem in one error", () => {
    try {
      loadSettings({ TARGET_PAGES: " , ", VIEWPORTS: "bad" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues).toHaveLength(3);
    }
  });
});
