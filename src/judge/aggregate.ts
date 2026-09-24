/**
 * Verdict aggregation: rolls per-screenshot results up into one status per
 * page (P026) and, later, a run-level summary (P027).
 *
 * Page status, worst first:
 *   fail   — any viewport has a "Real Bug" verdict
 *   review — no bug, but a human should look: an "Uncertain" verdict, a
 *            judge error, a change that wasn't judged, or a screenshot
 *            that couldn't be compared
 *   pass   — every viewport is unchanged or an "Acceptable Change"
 *
 * Tickets: P026, P027
 */

import type { DiffResult, Verdict } from "../diff/models.js";

export type PageStatus = "pass" | "review" | "fail";

const STATUS_RANK: Record<PageStatus, number> = { pass: 0, review: 1, fail: 2 };

export interface ViewportOutcome {
  viewport: string;
  status: PageStatus;
  /** Plain-English reason, e.g. "Real Bug (9/10)" or "unchanged". */
  reason: string;
  changed: boolean;
  percentChanged?: number;
  verdict?: Verdict;
  confidence?: number;
  explanation?: string;
}

export interface PageVerdict {
  page: string;
  status: PageStatus;
  /** One line explaining the page status, e.g. "Real Bug on mobile (9/10)". */
  summary: string;
  viewports: ViewportOutcome[];
}

/** A screenshot that couldn't be compared (see SkippedDiff in diff/runDiff.ts). */
export interface SkippedScreenshot {
  page: string;
  viewport: string;
  reason: string;
}

/** Works out the status of one screenshot. */
export function viewportOutcome(result: DiffResult): ViewportOutcome {
  const base = {
    viewport: result.viewport,
    changed: result.changed,
    percentChanged: result.percentChanged,
    ...(result.verdict && { verdict: result.verdict }),
    ...(result.confidence !== undefined && { confidence: result.confidence }),
    ...(result.explanation && { explanation: result.explanation }),
  };
  const conf = result.confidence !== undefined ? ` (${result.confidence}/10)` : "";

  if (!result.changed) return { ...base, status: "pass", reason: "unchanged" };
  if (result.judgeError) {
    return {
      ...base,
      status: "review",
      reason: `changed, couldn't be judged: ${result.judgeError}`,
    };
  }
  switch (result.verdict) {
    case "Real Bug":
      return { ...base, status: "fail", reason: `Real Bug${conf}` };
    case "Acceptable Change":
      return { ...base, status: "pass", reason: `Acceptable Change${conf}` };
    case "Uncertain":
      return { ...base, status: "review", reason: `Uncertain${conf}` };
    default:
      return { ...base, status: "review", reason: "changed, not judged" };
  }
}

function worst(statuses: PageStatus[]): PageStatus {
  return statuses.reduce<PageStatus>((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), "pass");
}

/** One-line explanation of a page's status, naming the viewports behind it. */
function summarize(status: PageStatus, viewports: ViewportOutcome[]): string {
  const hits = viewports.filter((v) => v.status === status);
  const list = (items: string[]) =>
    items.length <= 2
      ? items.join(" and ")
      : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

  if (status === "fail") {
    return `Real Bug on ${list(hits.map((v) => `${v.viewport}${v.confidence ? ` (${v.confidence}/10)` : ""}`))}`;
  }
  if (status === "review") {
    return `Needs review: ${hits.map((v) => `${v.viewport} ${v.reason}`).join("; ")}`;
  }
  const changed = viewports.filter((v) => v.changed);
  return changed.length === 0
    ? "No changes"
    : `Acceptable changes on ${list(changed.map((v) => v.viewport))}`;
}

/**
 * Rolls results up into one verdict per page, in the order pages first appear.
 * Skipped screenshots (couldn't be compared) count as needing review.
 */
export function rollupPages(
  results: DiffResult[],
  skipped: SkippedScreenshot[] = []
): PageVerdict[] {
  const byPage = new Map<string, ViewportOutcome[]>();
  const add = (page: string, outcome: ViewportOutcome) => {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(outcome);
  };

  for (const result of results) add(result.page, viewportOutcome(result));
  for (const s of skipped) {
    add(s.page, {
      viewport: s.viewport,
      status: "review",
      reason: `not compared: ${s.reason}`,
      changed: false,
    });
  }

  return [...byPage.entries()].map(([page, viewports]) => {
    const status = worst(viewports.map((v) => v.status));
    return { page, status, summary: summarize(status, viewports), viewports };
  });
}
