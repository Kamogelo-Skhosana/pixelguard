/**
 * Core judgment logic — scores each DiffResult via the vision LLM
 * and aggregates verdicts per page and per run.
 *
 * Tickets: P023, P024, P026, P027
 */

import type { DiffResult } from "../diff/models.js";
import type { ChangeContext } from "./context.js";
import type { LLMClient } from "./llmClient.js";

export async function judgeDiff(
  diff: DiffResult,
  context: ChangeContext,
  llm: LLMClient
): Promise<DiffResult> {
  // TODO (P023): build the prompt (prompts.ts), call llm.judge(),
  // parse the structured JSON response, and populate diff.verdict,
  // diff.confidence, diff.explanation.
  throw new Error("Not implemented");
}

export interface RunSummary {
  totalPages: number;
  realBugs: number;
  acceptableChanges: number;
  uncertain: number;
}

export function summarizeRun(diffs: DiffResult[]): RunSummary {
  // TODO (P026/P027): roll up per-page verdicts into a run-level summary.
  throw new Error("Not implemented");
}
