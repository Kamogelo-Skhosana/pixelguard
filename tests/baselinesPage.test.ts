/**
 * Tests for the baseline history page's wording (public/js/pages/baselines.js).
 *
 * Ticket: P043
 */

import { describe, expect, it } from "vitest";
import { describeSource } from "../public/js/pages/baselines.js";

describe("describeSource", () => {
  it.each([
    [
      { version: 1, source: { type: "accept", fromTag: "baseline", pages: null, screenshots: 0 } },
      "Original baseline (from before the first accept)",
    ],
    [
      { version: 2, source: { type: "accept", fromTag: "current", pages: null, screenshots: 6 } },
      'Accepted from "current" (all pages, 6 screenshots)',
    ],
    [
      {
        version: 3,
        source: { type: "accept", fromTag: "current", pages: ["home"], screenshots: 1 },
      },
      'Accepted from "current" (pages home, 1 screenshot)',
    ],
    [{ version: 4, source: { type: "restore", fromVersion: 2 } }, "Restored from version 2"],
    [{ version: 5, source: { type: "mystery" } }, "Unknown"],
    [{ version: 6 }, "Unknown"],
  ])("%j -> %s", (entry, text) => {
    expect(describeSource(entry)).toBe(text);
  });
});
