/**
 * Judge scenarios with mocked LLM responses — no live API calls.
 *
 * Uses the real sample screenshots from tests/fixtures/diff, the real diff
 * engine and the real judge; only the LLM is mocked (tests/helpers/mockLLM.ts).
 *
 * Ticket: P025
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffImages } from "../src/diff/differ.js";
import { isJudged, type DiffResult } from "../src/diff/models.js";
import type { ChangeContext } from "../src/judge/context.js";
import { judgeDiff, judgeDiffs } from "../src/judge/judge.js";
import { AnthropicClient } from "../src/judge/llmClient.js";
import { ERRORS, MockLLM, REPLIES, verdictReply } from "./helpers/mockLLM.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");
const context: ChangeContext = {
  dynamicRegions: [],
  changeDescription: "Changed the checkout button colour to green",
};

let dir: string;
/** A real changed diff: the button-colour fixture pair. */
let changed: DiffResult;
/** A real unchanged diff: the identical fixture pair. */
let unchanged: DiffResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-scenarios-"));
  const pair = async (name: string, page: string) =>
    diffImages(
      join(fixtures, name, "baseline.png"),
      join(fixtures, name, "current.png"),
      join(dir, `${page}.png`),
      page,
      "desktop"
    );
  changed = await pair("button-colour", "checkout");
  unchanged = await pair("identical", "about");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("each verdict is recorded as the model gave it", () => {
  it.each([
    ["Real Bug", REPLIES.realBug, 9],
    ["Acceptable Change", REPLIES.acceptable, 9],
    ["Uncertain", REPLIES.uncertain, 4],
  ] as const)("%s", async (verdict, reply, confidence) => {
    const judged = await judgeDiff(changed, context, new MockLLM([reply]));
    expect(judged).toMatchObject({ verdict, confidence, judgedBy: "mock-model" });
    expect(judged.explanation).toBeTruthy();
    expect(judged.judgeError).toBeUndefined();
    expect(isJudged(judged)).toBe(true);
  });

  it("keeps the observed changes", async () => {
    const judged = await judgeDiff(changed, context, new MockLLM([REPLIES.realBug]));
    expect(judged.observedChanges).toEqual(["Button moved up 24px"]);
  });

  it.each([1, 10])("accepts confidence %i at the edge of the range", async (confidence) => {
    const reply = verdictReply("Real Bug", confidence);
    expect((await judgeDiff(changed, context, new MockLLM([reply]))).confidence).toBe(confidence);
  });
});

describe("messy but valid replies are understood", () => {
  it.each([
    ["in a ```json code fence", REPLIES.fenced, "Real Bug"],
    ["with text before and after", REPLIES.withPreamble, "Acceptable Change"],
    ["with an extra field", REPLIES.extraField, "Real Bug"],
    ["with non-ASCII text", REPLIES.unicode, "Acceptable Change"],
  ])("%s", async (_label, reply, verdict) => {
    const llm = new MockLLM([reply]);
    const judged = await judgeDiff(changed, context, llm);
    expect(judged.verdict).toBe(verdict);
    expect(isJudged(judged)).toBe(true);
    expect(llm.calls).toHaveLength(1); // no re-ask needed
  });

  it("drops the extra field rather than storing it", async () => {
    const judged = await judgeDiff(changed, context, new MockLLM([REPLIES.extraField]));
    expect(judged).not.toHaveProperty("reasoning");
  });

  it("keeps non-ASCII text intact", async () => {
    const judged = await judgeDiff(changed, context, new MockLLM([REPLIES.unicode]));
    expect(judged.explanation).toBe("Price changed from R199 to R249 — expected ✓");
  });
});

describe("unreadable replies", () => {
  it("asks again once and uses the second, valid reply", async () => {
    const llm = new MockLLM([REPLIES.proseOnly, REPLIES.acceptable]);
    const judged = await judgeDiff(changed, context, llm);
    expect(judged.verdict).toBe("Acceptable Change");
    expect(llm.calls).toHaveLength(2);
  });

  it.each([
    ["prose with no JSON", REPLIES.proseOnly, /no JSON object/],
    ["cut-off JSON", REPLIES.truncated, /no JSON object|valid JSON/],
    ["an unknown verdict", REPLIES.wrongVerdict, /verdict/],
    ["confidence out of range", REPLIES.confidenceTooHigh, /confidence/],
    ["confidence as text", REPLIES.confidenceAsText, /confidence/],
    ["an empty explanation", REPLIES.emptyExplanation, /explanation/],
  ])("%s twice -> Uncertain with the reason", async (_label, reply, reason) => {
    const llm = new MockLLM([reply, reply]);
    const judged = await judgeDiff(changed, context, llm);
    expect(judged.verdict).toBe("Uncertain");
    expect(judged.confidence).toBeUndefined();
    expect(judged.judgeError).toMatch(reason);
    expect(judged.explanation).toMatch(/^Could not be judged automatically/);
    expect(isJudged(judged)).toBe(false);
    expect(llm.calls).toHaveLength(2);
  });

  it("respects parseRetries: 0", async () => {
    const llm = new MockLLM([REPLIES.proseOnly]);
    const judged = await judgeDiff(changed, context, llm, { parseRetries: 0 });
    expect(judged.verdict).toBe("Uncertain");
    expect(llm.calls).toHaveLength(1);
  });
});

describe("API failures (after the client's own retries)", () => {
  it.each([
    ["401 bad key", ERRORS.unauthorized, /check LLM_API_KEY/],
    ["429 rate limited", ERRORS.rateLimited, /429/],
    ["529 overloaded", ERRORS.overloaded, /Overloaded/],
    ["timeout", ERRORS.timeout, /timed out/],
    ["an unexpected error", ERRORS.unexpected, /unexpected error/],
  ])("%s -> Uncertain, not retried again by the judge", async (_label, makeError, reason) => {
    const llm = new MockLLM([makeError()]);
    const judged = await judgeDiff(changed, context, llm);
    expect(judged.verdict).toBe("Uncertain");
    expect(judged.judgeError).toMatch(reason);
    expect(judged.judgedBy).toBe("mock-model");
    expect(llm.calls).toHaveLength(1);
  });
});

describe("a whole run with different replies per screenshot", () => {
  it("gives each screenshot its own verdict, whatever order the replies arrive in", async () => {
    const pages = ["home", "checkout", "about", "cart", "blog"];
    const diffs = [
      ...pages.map((page) => ({ ...changed, page })),
      unchanged, // never sent
    ];
    const byPage: Record<string, string | Error> = {
      home: REPLIES.acceptable,
      checkout: REPLIES.realBug,
      about: REPLIES.uncertain,
      cart: ERRORS.overloaded(),
      blog: REPLIES.fenced,
    };
    const llm = new MockLLM((call) => byPage[call.target.split(" / ")[0]]);

    const results = await judgeDiffs(diffs, context, llm, { concurrency: 3 });

    expect(results.map((r) => [r.page, r.verdict, r.judgeError !== undefined])).toEqual([
      ["home", "Acceptable Change", false],
      ["checkout", "Real Bug", false],
      ["about", "Uncertain", false],
      ["cart", "Uncertain", true],
      ["blog", "Real Bug", false],
      ["about", undefined, false], // the unchanged screenshot
    ]);
    expect(llm.calls.map((c) => c.target).sort()).toEqual(
      pages.map((p) => `${p} / desktop`).sort()
    );
  });
});

describe("what the judge sends", () => {
  it("sends the real screenshots and the change context", async () => {
    const llm = new MockLLM([REPLIES.acceptable]);
    await judgeDiff(
      {
        ...changed,
        expectedChangeRegions: [
          { label: "Promo", kind: "ad", rect: { x: 20, y: 60, width: 60, height: 20 } },
        ],
      },
      context,
      llm
    );
    const { images, prompt } = llm.calls[0];

    // The 200x120 fixture is small enough to be sent whole.
    for (const data of [images.baseline, images.current, images.diff]) {
      const png = PNG.sync.read(Buffer.from(data, "base64"));
      expect([png.width, png.height]).toEqual([200, 120]);
    }
    expect(images.baseline).not.toBe(images.current);
    expect(prompt.user).toContain("Check: checkout page at desktop viewport");
    expect(prompt.user).toContain("Pixels changed: 1,200 (5.00% of the compared area)");
    expect(prompt.user).toContain("- Promo (ad) at x=20, y=60, 60x20px");
    expect(prompt.user).toContain("Changed the checkout button colour to green");
    expect(prompt.system).toContain("Reply with ONLY a JSON object");
  });
});

describe("test safety net", () => {
  it("MockLLM fails loudly when it runs out of replies", async () => {
    const llm = new MockLLM([]);
    const judged = await judgeDiff(changed, context, llm);
    expect(judged.judgeError).toMatch(/MockLLM ran out of replies/);
  });

  it("blocks live calls to the real API during tests", async () => {
    const real = new AnthropicClient({ apiKey: "sk-not-real", model: "m", maxRetries: 0 });
    await expect(
      real.judge({ baseline: "", current: "", diff: "" }, { system: "", user: "" })
    ).rejects.toThrow(/Blocked a live LLM API call to api\.anthropic\.com/);
  });
});
