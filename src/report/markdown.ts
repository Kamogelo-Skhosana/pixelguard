/**
 * Markdown report generation for AI-judged diff results (Phase 2).
 *
 * Follows the design in docs/REPORT_TEMPLATE.md (P029); the expected output
 * is shown in examples/sample-report/report.md.
 *
 * Tickets: P029, P030, P031
 */

import type { DiffResult } from "../diff/models.js";
import type { RunSummary } from "../judge/judge.js";

export function generateMarkdownReport(
  _targetUrl: string,
  _summary: RunSummary,
  _results: DiffResult[]
): string {
  // TODO (P030): implement the template in docs/REPORT_TEMPLATE.md.
  throw new Error("Not implemented");
}

export function writeReport(_content: string, _path: string): void {
  // TODO (P031): write content to path.
  throw new Error("Not implemented");
}
