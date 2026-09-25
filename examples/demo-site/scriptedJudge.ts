/**
 * A scripted stand-in for the AI judge, for the demo site only.
 *
 * It answers the way a correct judge would for the demo's known changes
 * (home: the date changed -> Acceptable Change; pricing: the cards overlap ->
 * Real Bug) without calling any API. Use it to rehearse a presentation with
 * no internet or API key: `npm run demo -- --scripted-judge`.
 *
 * It reports itself as "scripted-demo-judge" everywhere (console, report,
 * dashboard), so its verdicts can't be mistaken for a real model's.
 *
 * Ticket: P049
 */

import type { JudgeImages, LLMClient, LLMReply } from "../../src/judge/llmClient.js";
import type { JudgePrompt } from "../../src/judge/prompts.js";

export const SCRIPTED_JUDGE_MODEL = "scripted-demo-judge";

/** The verdicts, keyed by demo page name. */
const ANSWERS: Record<string, object> = {
  home: {
    verdict: "Acceptable Change",
    confidence: 9,
    explanation:
      "Only the 'last updated' date changed, which is what the developer note describes. The layout, colours and other text are the same.",
    observedChanges: ["'Last updated' date changed"],
  },
  pricing: {
    verdict: "Real Bug",
    confidence: 9,
    explanation:
      "The pricing cards now overlap and the last card runs off the edge, cutting through the prices. The developer note only mentions a date change, so this looks accidental.",
    observedChanges: ["Pricing cards overlap", "Last card runs off the page"],
  },
};

const UNKNOWN = {
  verdict: "Uncertain",
  confidence: 2,
  explanation:
    "The scripted demo judge only knows the demo site's pages. Use a real model (LLM_API_KEY) for anything else.",
  observedChanges: [],
};

export class ScriptedDemoJudge implements LLMClient {
  readonly model = SCRIPTED_JUDGE_MODEL;
  /** Pages judged so far, e.g. "pricing / mobile" (for tests). */
  readonly calls: string[] = [];

  async judge(_images: JudgeImages, prompt: JudgePrompt): Promise<LLMReply> {
    const match = /^Check: (\S+) page at (\S+) viewport/m.exec(prompt.user);
    const page = match?.[1] ?? "unknown";
    this.calls.push(`${page} / ${match?.[2] ?? "unknown"}`);
    return {
      text: JSON.stringify(ANSWERS[page] ?? UNKNOWN),
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
