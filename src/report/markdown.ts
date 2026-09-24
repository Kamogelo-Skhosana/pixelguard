/**
 * Markdown report generation for AI-judged diff results (Phase 2).
 *
 * Tickets: P029, P030, P031
 */

import type { DiffResult } from "../diff/models.js";
import type { RunSummary } from "../judge/judge.js";

export function generateMarkdownReport(
  targetUrl: string,
  summary: RunSummary,
  results: DiffResult[]
): string {
  // TODO (P029/P030): render a report section per page, showing its
  // verdict, confidence, explanation, and a link to the diff image.
  throw new Error("Not implemented");
}

export function writeReport(content: string, path: string): void {
  // TODO (P031): write content to path.
  throw new Error("Not implemented");
}
