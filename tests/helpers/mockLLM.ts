/**
 * Shared mock LLM client for tests — no real API calls.
 *
 * Replies can be queued (used in order), chosen per screenshot with a
 * function, or thrown as errors. Every call is recorded so tests can check
 * what the judge sent.
 *
 * Ticket: P025
 */

import type { Verdict } from "../../src/diff/models.js";
import {
  LLMError,
  type JudgeImages,
  type LLMClient,
  type LLMReply,
} from "../../src/judge/llmClient.js";
import type { JudgePrompt } from "../../src/judge/prompts.js";

/** A reply the mock should give: the text to return, or an error to throw. */
export type MockReply = string | Error;

export interface MockCall {
  images: JudgeImages;
  prompt: JudgePrompt;
  /** "page / viewport", read from the prompt, for easy assertions. */
  target: string;
}

/** Builds a well-formed verdict reply. */
export function verdictReply(
  verdict: Verdict,
  confidence = 8,
  explanation = `Judged as ${verdict}.`,
  observedChanges: string[] = []
): string {
  return JSON.stringify({ verdict, confidence, explanation, observedChanges });
}

/** Ready-made replies covering common and awkward model outputs. */
export const REPLIES = {
  realBug: verdictReply("Real Bug", 9, "The checkout button overlaps the order total.", [
    "Button moved up 24px",
  ]),
  acceptable: verdictReply("Acceptable Change", 9, "The heading text matches the developer note."),
  uncertain: verdictReply(
    "Uncertain",
    4,
    "The banner changed but nothing says whether it was intended."
  ),
  fenced: "```json\n" + verdictReply("Real Bug", 7) + "\n```",
  withPreamble:
    "Here is my assessment:\n\n" + verdictReply("Acceptable Change", 8) + "\n\nLet me know!",
  extraField: JSON.stringify({
    verdict: "Real Bug",
    confidence: 6,
    explanation: "Footer is cut off.",
    reasoning: "extra field the schema doesn't define",
  }),
  unicode: verdictReply("Acceptable Change", 8, "Price changed from R199 to R249 — expected ✓"),
  proseOnly: "The page looks fine to me, it's an acceptable change.",
  truncated: '{"verdict": "Real Bug", "confidence": 8, "explan',
  wrongVerdict: JSON.stringify({ verdict: "Bug", confidence: 8, explanation: "x" }),
  confidenceTooHigh: JSON.stringify({ verdict: "Real Bug", confidence: 12, explanation: "x" }),
  confidenceAsText: JSON.stringify({ verdict: "Real Bug", confidence: "high", explanation: "x" }),
  emptyExplanation: JSON.stringify({ verdict: "Uncertain", confidence: 3, explanation: "" }),
} as const;

/** Errors the real client can throw after its own retries. */
export const ERRORS = {
  unauthorized: () => new LLMError("LLM API error 401: invalid x-api-key (check LLM_API_KEY)", 401),
  rateLimited: () => new LLMError("LLM API error 429: rate limited after 4 attempts", 429, true),
  overloaded: () => new LLMError("LLM API error 529: Overloaded after 4 attempts", 529, true),
  timeout: () =>
    new LLMError("LLM request timed out after 60000ms after 4 attempts", undefined, true),
  unexpected: () => new TypeError("something unexpected broke"),
};

export class MockLLM implements LLMClient {
  readonly model: string;
  readonly calls: MockCall[] = [];
  private readonly queue: MockReply[];
  private readonly pick?: (call: MockCall, index: number) => MockReply;

  /**
   * @param replies a queue of replies used in order, or a function choosing
   *   the reply for each call. When the queue runs out, calls fail loudly so
   *   a test never silently gets a default answer.
   */
  constructor(
    replies: MockReply[] | ((call: MockCall, index: number) => MockReply) = [],
    options: { model?: string } = {}
  ) {
    this.model = options.model ?? "mock-model";
    if (typeof replies === "function") {
      this.queue = [];
      this.pick = replies;
    } else {
      this.queue = [...replies];
    }
  }

  async judge(images: JudgeImages, prompt: JudgePrompt): Promise<LLMReply> {
    const match = /^Check: (\S+) page at (\S+) viewport/m.exec(prompt.user);
    const call: MockCall = {
      images,
      prompt,
      target: match ? `${match[1]} / ${match[2]}` : "unknown",
    };
    this.calls.push(call);

    let reply: MockReply | undefined;
    if (this.pick) {
      reply = this.pick(call, this.calls.length - 1);
    } else {
      reply = this.queue.shift();
      if (reply === undefined) {
        throw new Error(`MockLLM ran out of replies (call ${this.calls.length}: ${call.target})`);
      }
    }
    if (reply instanceof Error) throw reply;
    return {
      text: reply,
      model: this.model,
      usage: { inputTokens: 1000, outputTokens: 50 },
    };
  }
}
