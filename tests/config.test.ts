/**
 * Tests for configuration helpers.
 *
 * Ticket: P011
 */

import { describe, it, expect } from "vitest";
import { sqlitePathFromUrl } from "../src/config.js";

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
