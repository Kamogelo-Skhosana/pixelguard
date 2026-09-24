/**
 * Tests for the judge prompt design.
 *
 * Ticket: P021
 */

import { describe, expect, it } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import type { ChangeContext } from "../src/judge/context.js";
import {
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  JudgeResponseSchema,
  renderTemplate,
  VERDICTS,
} from "../src/judge/prompts.js";

function diff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    page: "checkout",
    viewport: "mobile",
    pixelDiffCount: 4820,
    totalPixels: 390 * 2000,
    percentChanged: 0.6179,
    changed: true,
    sizeChanged: false,
    baselineSize: { width: 390, height: 2000 },
    currentSize: { width: 390, height: 2000 },
    diffImagePath: "d.png",
    baselineImagePath: "b.png",
    currentImagePath: "c.png",
    ...overrides,
  };
}

const context: ChangeContext = {
  dynamicRegions: [],
  changeDescription: "Redesigned the checkout button",
};

describe("renderTemplate", () => {
  it("fills placeholders", () => {
    expect(renderTemplate("Hi {name}, {name}! {x}", { name: "Kamo", x: "1" })).toBe(
      "Hi Kamo, Kamo! 1"
    );
  });

  it("throws on placeholders without a value", () => {
    expect(() => renderTemplate("{page} {pagee}", { page: "home" })).toThrow(
      /Missing prompt values: pagee/
    );
  });

  it("doesn't re-process placeholders inside inserted values", () => {
    expect(renderTemplate("{a}", { a: "{b}" })).toBe("{b}");
  });
});

describe("buildJudgePrompt", () => {
  it("includes the facts about the diff", () => {
    const { system, user } = buildJudgePrompt(diff(), context);
    expect(system).toBe(JUDGE_SYSTEM_PROMPT);
    expect(user).toContain("Check: checkout page at mobile viewport");
    expect(user).toContain("Screenshot size: 390x2000px");
    expect(user).toContain("Pixels changed: 4,820 (0.62% of the compared area)");
    expect(user).toContain("<developer_note>\nRedesigned the checkout button\n</developer_note>");
    expect(user).toContain("BASELINE, CURRENT, DIFF");
    expect(user).not.toMatch(/\{[a-zA-Z]+\}/); // no unfilled placeholders
  });

  it("describes a size change", () => {
    const { user } = buildJudgePrompt(
      diff({ sizeChanged: true, currentSize: { width: 390, height: 2300 } }),
      context
    );
    expect(user).toContain(
      "Screenshot size: changed from 390x2000px (BASELINE) to 390x2300px (CURRENT)"
    );
  });

  it("lists expected-change and ignored regions with coordinates", () => {
    const { user } = buildJudgePrompt(
      diff({
        expectedChangeRegions: [
          { label: "Promo banner", kind: "ad", rect: { x: 0, y: 120, width: 390, height: 60 } },
        ],
        ignoredRegions: [{ label: "Clock", rect: { x: 300, y: 10, width: 80, height: 20 } }],
      }),
      context
    );
    expect(user).toContain("- Promo banner (ad) at x=0, y=120, 390x60px");
    expect(user).toContain("- Clock at x=300, y=10, 80x20px");
  });

  it("says none when there are no regions or description", () => {
    const { user } = buildJudgePrompt(diff(), { dynamicRegions: [], changeDescription: "" });
    expect(user.match(/- none/g)).toHaveLength(2);
    expect(user).toContain("<developer_note>\n(none given)\n</developer_note>");
  });

  it("formats tiny and zero percentages sensibly", () => {
    expect(buildJudgePrompt(diff({ percentChanged: 0.0001 }), context).user).toContain(
      "(<0.01% of"
    );
    expect(buildJudgePrompt(diff({ percentChanged: 0 }), context).user).toContain("(0% of");
  });

  it("keeps a developer note with braces intact", () => {
    const { user } = buildJudgePrompt(diff(), {
      dynamicRegions: [],
      changeDescription: "Changed {page} template",
    });
    expect(user).toContain("Changed {page} template");
  });
});

describe("buildJudgePrompt with a cropped view (P023)", () => {
  const view = {
    top: 1000,
    height: 600,
    fullWidth: 1440,
    fullHeight: 6000,
    scale: 0.5,
    imageWidth: 720,
    imageHeight: 300,
  };

  it("describes the crop and scale", () => {
    const { user } = buildJudgePrompt(diff(), context, view);
    expect(user).toContain(
      "Images shown: cropped to the changed part of the page (rows 1000-1600 of 6000), scaled to 50%; each image is 720x300px"
    );
  });

  it("describes an uncropped, unscaled view", () => {
    const full = { ...view, top: 0, height: 6000, scale: 1, imageWidth: 1440, imageHeight: 6000 };
    expect(buildJudgePrompt(diff(), context, full).user).toContain(
      "Images shown: the full screenshot at actual size; each image is 1440x6000px"
    );
  });

  it("converts region coordinates to the cropped images and drops regions outside", () => {
    const { user } = buildJudgePrompt(
      diff({
        expectedChangeRegions: [
          { label: "Inside", kind: "ad", rect: { x: 100, y: 1200, width: 200, height: 100 } },
          { label: "Outside", kind: "ad", rect: { x: 0, y: 100, width: 50, height: 50 } },
        ],
        ignoredRegions: [
          { label: "Straddles top", rect: { x: 0, y: 900, width: 40, height: 200 } },
        ],
      }),
      context,
      view
    );
    expect(user).toContain("- Inside (ad) at x=50, y=100, 100x50px");
    expect(user).not.toContain("Outside");
    expect(user).toContain("- Straddles top at x=0, y=0, 20x50px");
  });
});

describe("JUDGE_SYSTEM_PROMPT", () => {
  it("explains the three images in order and every verdict", () => {
    const order = ["BASELINE", "CURRENT", "DIFF"].map((w) =>
      JUDGE_SYSTEM_PROMPT.indexOf(`. ${w}:`)
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const verdict of VERDICTS) expect(JUDGE_SYSTEM_PROMPT).toContain(`"${verdict}"`);
  });

  it("guards against instructions hidden in screenshots or the developer note", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/not instructions/);
  });

  it("asks for JSON only, with every field the schema needs", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Reply with ONLY a JSON object");
    for (const key of Object.keys(JudgeResponseSchema.shape)) {
      expect(JUDGE_SYSTEM_PROMPT).toContain(`"${key}"`);
    }
  });
});

describe("JudgeResponseSchema", () => {
  const valid = {
    verdict: "Real Bug",
    confidence: 8,
    explanation: "The checkout button overlaps the price.",
    observedChanges: ["Button moved up 20px"],
  };

  it("accepts a valid response and defaults observedChanges", () => {
    expect(JudgeResponseSchema.parse(valid)).toEqual(valid);
    const { observedChanges: _, ...rest } = valid;
    expect(JudgeResponseSchema.parse(rest).observedChanges).toEqual([]);
  });

  it.each([
    ["an unknown verdict", { verdict: "Bug" }],
    ["confidence above 10", { confidence: 11 }],
    ["confidence below 1", { confidence: 0 }],
    ["a fractional confidence", { confidence: 7.5 }],
    ["an empty explanation", { explanation: "  " }],
    ["extra fields", { mood: "happy" }],
  ])("rejects %s", (_label, change) => {
    expect(JudgeResponseSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
