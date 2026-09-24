/**
 * Core judgment logic — scores each DiffResult via the vision LLM
 * and aggregates verdicts per page and per run.
 *
 * Tickets: P023, P024, P026, P027
 */

import type { DiffResult } from "../diff/models.js";
import { withJudgeError, withJudgement } from "../diff/models.js";
import type { ChangeContext } from "./context.js";
import { prepareJudgeImages, type PrepareOptions } from "./imagePrep.js";
import { LLMError, type LLMClient } from "./llmClient.js";
import { buildJudgePrompt, JudgeResponseSchema, type JudgeResponse } from "./prompts.js";

/** Thrown when the model's reply isn't a valid verdict. */
export class JudgeParseError extends Error {
  constructor(
    message: string,
    public readonly reply: string
  ) {
    super(message);
    this.name = "JudgeParseError";
  }
}

/**
 * Extracts and validates the verdict JSON from the model's reply.
 * Tolerates markdown code fences, text around the JSON object, and extra keys.
 */
export function parseJudgeResponse(reply: string): JudgeResponse {
  const snippet = reply.length > 200 ? `${reply.slice(0, 200)}...` : reply;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new JudgeParseError(`The judge's reply contained no JSON object: ${snippet}`, reply);
  }

  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch (err) {
    throw new JudgeParseError(
      `The judge's reply wasn't valid JSON (${(err as Error).message}): ${snippet}`,
      reply
    );
  }

  // Extra keys the model adds (e.g. "reasoning") are dropped rather than
  // rejected, so a good verdict isn't thrown away over an unused field.
  const parsed = JudgeResponseSchema.strip().safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new JudgeParseError(
      `The judge's reply didn't match the verdict format (${issues})`,
      reply
    );
  }
  return parsed.data;
}

export interface JudgeOptions {
  /** How the images are cropped/scaled before sending. */
  images?: PrepareOptions;
  /**
   * Times to ask again when the reply can't be parsed (default: 1).
   * API errors are retried inside the LLM client, not here.
   */
  parseRetries?: number;
}

/**
 * Judges one diff with the LLM and returns a copy with the verdict filled in.
 *
 * - Unchanged diffs are returned as-is (nothing to judge, no API call).
 * - If the LLM call fails or its reply can't be parsed (after parseRetries),
 *   the diff is marked "Uncertain" with a judgeError instead of throwing,
 *   so one bad screenshot never stops the run.
 */
export async function judgeDiff(
  diff: DiffResult,
  context: ChangeContext,
  llm: LLMClient,
  options: JudgeOptions = {}
): Promise<DiffResult> {
  if (!diff.changed) return diff;
  const parseRetries = options.parseRetries ?? 1;

  let prepared;
  try {
    prepared = await prepareJudgeImages(
      {
        baseline: diff.baselineImagePath,
        current: diff.currentImagePath,
        diff: diff.diffImagePath,
      },
      options.images
    );
  } catch (err) {
    return withJudgeError(
      diff,
      `could not load the screenshots: ${(err as Error).message}`,
      llm.model
    );
  }

  const prompt = buildJudgePrompt(diff, context, prepared.view);

  let lastError = "";
  for (let attempt = 0; attempt <= parseRetries; attempt++) {
    let reply;
    try {
      reply = await llm.judge(prepared.images, prompt);
    } catch (err) {
      const message = err instanceof LLMError ? err.message : `unexpected error: ${String(err)}`;
      return withJudgeError(diff, message, llm.model);
    }

    try {
      return withJudgement(diff, parseJudgeResponse(reply.text), reply.model);
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return withJudgeError(diff, lastError, llm.model);
}

export interface JudgeManyOptions extends JudgeOptions {
  /** How many diffs to judge at the same time (default: 2). */
  concurrency?: number;
  /** Called after each changed diff is judged, e.g. to print progress. */
  onJudged?: (result: DiffResult) => void;
}

/**
 * Judges every changed diff (unchanged ones pass through untouched),
 * a few at a time. Results come back in the same order as the input.
 */
export async function judgeDiffs(
  diffs: DiffResult[],
  context: ChangeContext,
  llm: LLMClient,
  options: JudgeManyOptions = {}
): Promise<DiffResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results = [...diffs];
  const queue = diffs.map((d, i) => i).filter((i) => diffs[i].changed);

  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results[next] = await judgeDiff(diffs[next], context, llm, options);
      options.onJudged?.(results[next]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

// The run-level summary lives with the page rollup in aggregate.ts (P026/P027);
// re-exported here for convenience.
export { summarizeRun, type RunSummary } from "./aggregate.js";
