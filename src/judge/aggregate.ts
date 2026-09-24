/**
 * Verdict aggregation: rolls per-screenshot results up into one status per
 * page (P026) and a run-level summary (P027).
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

export interface RunSummary {
  /** Overall result: the worst page status. */
  status: PageStatus;
  /** One line for the console and reports, e.g. "FAIL: 2 real bugs on 1 page, 3 acceptable changes". */
  headline: string;

  /** Number of pages checked. */
  totalPages: number;
  /** Screenshots (page/viewport) judged a Real Bug. */
  realBugs: number;
  /** Screenshots judged an Acceptable Change. */
  acceptableChanges: number;
  /** Screenshots the judge was Uncertain about (not counting failed judgements). */
  uncertain: number;
  /** Changed screenshots the judge couldn't give a verdict for (API error, unreadable reply...). */
  judgeErrors: number;
  /** Changed screenshots that weren't sent to the judge. */
  notJudged: number;
  /** Screenshots that couldn't be compared (new, removed or failed pages). */
  skipped: number;

  pages: { pass: number; review: number; fail: number };
  screenshots: { total: number; changed: number; unchanged: number };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Rolls results up into a run-level summary (P027): page statuses plus
 * how many screenshots got each verdict.
 */
export function summarizeRun(results: DiffResult[], skipped: SkippedScreenshot[] = []): RunSummary {
  const pages = rollupPages(results, skipped);
  const changed = results.filter((r) => r.changed);
  const count = (fn: (r: DiffResult) => boolean) => changed.filter(fn).length;

  const summary = {
    totalPages: pages.length,
    realBugs: count((r) => !r.judgeError && r.verdict === "Real Bug"),
    acceptableChanges: count((r) => !r.judgeError && r.verdict === "Acceptable Change"),
    uncertain: count((r) => !r.judgeError && r.verdict === "Uncertain"),
    judgeErrors: count((r) => r.judgeError !== undefined),
    notJudged: count((r) => r.verdict === undefined),
    skipped: skipped.length,
    pages: {
      pass: pages.filter((p) => p.status === "pass").length,
      review: pages.filter((p) => p.status === "review").length,
      fail: pages.filter((p) => p.status === "fail").length,
    },
    screenshots: {
      total: results.length,
      changed: changed.length,
      unchanged: results.length - changed.length,
    },
  };
  const status = worst(pages.map((p) => p.status));
  return { status, headline: runHeadline(status, summary), ...summary };
}

/** Builds the one-line result, mentioning only the counts that aren't zero. */
function runHeadline(status: PageStatus, s: Omit<RunSummary, "status" | "headline">): string {
  if (s.totalPages === 0) return "PASS: nothing to compare";

  const parts: string[] = [];
  if (s.realBugs > 0) {
    parts.push(`${plural(s.realBugs, "real bug")} on ${plural(s.pages.fail, "page")}`);
  }
  if (s.uncertain > 0) parts.push(`${s.uncertain} uncertain`);
  if (s.judgeErrors > 0) parts.push(`${s.judgeErrors} couldn't be judged`);
  if (s.notJudged > 0) parts.push(`${s.notJudged} changed but not judged`);
  if (s.skipped > 0) parts.push(`${s.skipped} not compared`);
  if (s.acceptableChanges > 0) parts.push(plural(s.acceptableChanges, "acceptable change"));
  if (parts.length === 0) parts.push("no changes");

  const pagesPart = `${plural(s.totalPages, "page")} checked`;
  return `${status.toUpperCase()}: ${parts.join(", ")} (${pagesPart})`;
}
