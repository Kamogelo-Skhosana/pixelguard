/**
 * Tests for the judge layer, using a fake LLM client (no real API calls).
 *
 * Tickets: P021-P028
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { savePng } from "../src/diff/imageCompare.js";
import type { DiffResult } from "../src/diff/models.js";
import type { ChangeContext } from "../src/judge/context.js";
import { judgeDiff, judgeDiffs, JudgeParseError, parseJudgeResponse } from "../src/judge/judge.js";
import {
  LLMError,
  type JudgeImages,
  type LLMClient,
  type LLMReply,
} from "../src/judge/llmClient.js";
import type { JudgePrompt } from "../src/judge/prompts.js";

const VERDICT_JSON = JSON.stringify({
  verdict: "Real Bug",
  confidence: 8,
  explanation: "The button overlaps the price.",
  observedChanges: ["Button moved up"],
});

/** Fake LLM: returns (or throws) the queued replies in order and records calls. */
class FakeLLM implements LLMClient {
  readonly model = "fake-model";
  calls: { images: JudgeImages; prompt: JudgePrompt }[] = [];
  constructor(private replies: (string | Error)[]) {}
  async judge(images: JudgeImages, prompt: JudgePrompt): Promise<LLMReply> {
    this.calls.push({ images, prompt });
    const next = this.replies.shift() ?? VERDICT_JSON;
    if (next instanceof Error) throw next;
    return { text: next, model: "fake-model-v1", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const context: ChangeContext = { dynamicRegions: [], changeDescription: "New button" };
let dir: string;
let diff: DiffResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-judge-"));
  const png = (grey: number) => {
    const p = new PNG({ width: 20, height: 20 });
    for (let i = 0; i < p.data.length; i += 4) p.data.set([grey, grey, grey, 255], i);
    return p;
  };
  await savePng(png(255), join(dir, "b.png"));
  await savePng(png(200), join(dir, "c.png"));
  await savePng(png(128), join(dir, "d.png"));
  diff = {
    page: "home",
    viewport: "desktop",
    pixelDiffCount: 400,
    totalPixels: 400,
    percentChanged: 100,
    changed: true,
    sizeChanged: false,
    baselineSize: { width: 20, height: 20 },
    currentSize: { width: 20, height: 20 },
    baselineImagePath: join(dir, "b.png"),
    currentImagePath: join(dir, "c.png"),
    diffImagePath: join(dir, "d.png"),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseJudgeResponse (P023)", () => {
  it("parses a plain JSON reply", () => {
    expect(parseJudgeResponse(VERDICT_JSON)).toMatchObject({ verdict: "Real Bug", confidence: 8 });
  });

  it("tolerates code fences and surrounding text", () => {
    const reply = "Here is my verdict:\n```json\n" + VERDICT_JSON + "\n```\nThanks!";
    expect(parseJudgeResponse(reply).verdict).toBe("Real Bug");
  });

  it.each([
    ["no JSON", "I think it's fine.", /no JSON object/],
    ["broken JSON", '{"verdict": "Real Bug",', /no JSON object|wasn't valid JSON/],
    ["invalid JSON", "{verdict: Real Bug}", /wasn't valid JSON/],
    ["a wrong verdict", '{"verdict":"Bug","confidence":5,"explanation":"x"}', /verdict:/],
    ["missing fields", '{"verdict":"Uncertain"}', /confidence.*explanation|explanation/],
  ])("rejects %s", (_label, reply, message) => {
    expect(() => parseJudgeResponse(reply)).toThrow(JudgeParseError);
    expect(() => parseJudgeResponse(reply)).toThrow(message);
  });
});

describe("judgeDiff (P023)", () => {
  it("sends the three images and prompt, and fills in the verdict", async () => {
    const llm = new FakeLLM([VERDICT_JSON]);
    const judged = await judgeDiff(diff, context, llm);

    expect(judged).toMatchObject({
      verdict: "Real Bug",
      confidence: 8,
      explanation: "The button overlaps the price.",
      observedChanges: ["Button moved up"],
      judgedBy: "fake-model-v1",
    });
    expect(llm.calls).toHaveLength(1);
    const { images, prompt } = llm.calls[0];
    const grey = (b64: string) => PNG.sync.read(Buffer.from(b64, "base64")).data[0];
    expect([grey(images.baseline), grey(images.current), grey(images.diff)]).toEqual([
      255, 200, 128,
    ]);
    expect(prompt.user).toContain("Check: home page at desktop viewport");
    expect(prompt.user).toContain("New button");
  });

  it("doesn't call the LLM for unchanged screenshots", async () => {
    const llm = new FakeLLM([]);
    const unchanged = { ...diff, changed: false, pixelDiffCount: 0, percentChanged: 0 };
    expect(await judgeDiff(unchanged, context, llm)).toBe(unchanged);
    expect(llm.calls).toHaveLength(0);
  });

  it("asks again once when the reply can't be parsed", async () => {
    const llm = new FakeLLM(["not json", VERDICT_JSON]);
    const judged = await judgeDiff(diff, context, llm);
    expect(judged.verdict).toBe("Real Bug");
    expect(llm.calls).toHaveLength(2);
  });

  it("marks the diff Uncertain when replies stay unreadable", async () => {
    const llm = new FakeLLM(["nope", "still nope"]);
    const judged = await judgeDiff(diff, context, llm);
    expect(judged).toMatchObject({ verdict: "Uncertain", judgedBy: "fake-model" });
    expect(judged.judgeError).toMatch(/no JSON object/);
    expect(llm.calls).toHaveLength(2);
  });

  it("marks the diff Uncertain when the LLM call fails, without retrying here", async () => {
    const llm = new FakeLLM([new LLMError("LLM API error 401: invalid key (check LLM_API_KEY)")]);
    const judged = await judgeDiff(diff, context, llm);
    expect(judged.verdict).toBe("Uncertain");
    expect(judged.judgeError).toContain("check LLM_API_KEY");
    expect(llm.calls).toHaveLength(1);
  });

  it("marks the diff Uncertain when the screenshots can't be loaded", async () => {
    const llm = new FakeLLM([]);
    const judged = await judgeDiff(
      { ...diff, baselineImagePath: join(dir, "gone.png") },
      context,
      llm
    );
    expect(judged.judgeError).toMatch(/could not load the screenshots.*Image not found/);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("judgeDiffs (P023)", () => {
  it("judges changed diffs, skips unchanged ones, and keeps the order", async () => {
    const unchanged = { ...diff, page: "about", changed: false };
    const replies = [
      VERDICT_JSON,
      JSON.stringify({ verdict: "Acceptable Change", confidence: 9, explanation: "Expected." }),
    ];
    const llm = new FakeLLM(replies);
    const seen: string[] = [];
    const results = await judgeDiffs(
      [diff, unchanged, { ...diff, page: "checkout" }],
      context,
      llm,
      { concurrency: 1, onJudged: (r) => seen.push(r.page) }
    );

    expect(results.map((r) => [r.page, r.verdict])).toEqual([
      ["home", "Real Bug"],
      ["about", undefined],
      ["checkout", "Acceptable Change"],
    ]);
    expect(seen).toEqual(["home", "checkout"]);
    expect(llm.calls).toHaveLength(2);
  });

  it("runs several judgements at once", async () => {
    let active = 0;
    let peak = 0;
    const slow: LLMClient = {
      model: "slow",
      async judge() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { text: VERDICT_JSON, model: "slow", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const many = Array.from({ length: 6 }, (_, i) => ({ ...diff, page: `p${i}` }));
    await judgeDiffs(many, context, slow, { concurrency: 3 });
    expect(peak).toBe(3);
  });
});

describe("judgeDiff with a fully mocked LLM (P025)", () => {
  it.todo("covers every verdict and failure scenario using shared mocked LLM responses");
});

describe("summarizeRun", () => {
  it.todo("correctly counts real bugs, acceptable changes, and uncertain verdicts (P026/P027)");
});
