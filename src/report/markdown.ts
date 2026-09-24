/**
 * Markdown report generation for AI-judged diff results (Phase 2).
 *
 * Follows the design in docs/REPORT_TEMPLATE.md (P029); the expected output
 * is shown in examples/sample-report/report.md, which a test regenerates
 * and compares against.
 *
 * Tickets: P029, P030, P031
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DiffResult } from "../diff/models.js";
import {
  rollupPages,
  summarizeRun,
  type PageStatus,
  type PageVerdict,
  type RunSummary,
  type SkippedScreenshot,
} from "../judge/aggregate.js";

export interface MarkdownReportInput {
  results: DiffResult[];
  /** Screenshots that couldn't be compared. */
  skipped?: SkippedScreenshot[];
  targetUrl?: string;
  baselineTag: string;
  currentTag: string;
  /** What changed in this build (P020). */
  changeDescription?: string;
  /** Shown in the report; passed in so output is deterministic. */
  generatedAt: Date;
  /** Folder the report will be written to — image links are relative to it. */
  reportDir: string;
  /** Path of the JSON results file, if one was written (linked in the footer). */
  jsonPath?: string;
}

const PROJECT_URL = "https://github.com/Kamogelo-Skhosana/pixelguard";
const IMAGE_WIDTH = 260;

const STATUS: Record<PageStatus, { mark: string; word: string }> = {
  fail: { mark: "❌", word: "FAIL" },
  review: { mark: "⚠️", word: "REVIEW" },
  pass: { mark: "✅", word: "PASS" },
};
const RANK: Record<PageStatus, number> = { fail: 0, review: 1, pass: 2 };

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Escapes text from outside pixelguard (page names, explanations, notes,
 * errors) so it can't add formatting, links, HTML or table columns.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_[\]|])/g, "\\$1")
    .replace(/^(\s*)([#+-]|\d+\.)(?=\s)/gm, "$1\\$2");
}

/** Escapes text for a single table cell: no line breaks allowed. */
function cell(text: string): string {
  return escapeMarkdown(text.replace(/\s*\r?\n\s*/g, " "));
}

/** Turns (possibly multi-line) text into a blockquote. */
function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? ">" : `> ${escapeMarkdown(line)}`))
    .join("\n");
}

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces to "-". */
export function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Link target for a file, relative to the report folder, with forward
 * slashes and each path segment URL-encoded (e.g. spaces -> %20).
 */
export function relativeLink(reportDir: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
  return relative(resolve(reportDir), absolute)
    .split(sep)
    .join("/")
    .split("/")
    .map((segment) => (segment === ".." || segment === "." ? segment : encodeURIComponent(segment)))
    .join("/");
}

function percent(p: number): string {
  if (p === 0) return "0%";
  if (p < 0.01) return "<0.01%";
  return `${p.toFixed(2)}%`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function listWords(items: string[]): string {
  return items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function banner(run: RunSummary): string {
  const [status, rest] = run.headline.split(/:(.*)/s);
  return `> ${STATUS[run.status].mark} **${status}:**${rest ?? ""}`;
}

function runDetails(input: MarkdownReportInput): string {
  const models = [
    ...new Set(input.results.map((r) => r.judgedBy).filter((m): m is string => Boolean(m))),
  ];
  const rows: [string, string][] = [];
  if (input.targetUrl) rows.push(["Target", cell(input.targetUrl)]);
  rows.push(["Compared", `\`${input.baselineTag}\` → \`${input.currentTag}\``]);
  rows.push(["Judge", models.length > 0 ? cell(models.join(", ")) : "not judged"]);
  rows.push(["Generated", input.generatedAt.toISOString()]);

  const lines = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| **${k}** | ${v} |`)];
  if (input.changeDescription) {
    lines.push("", "**What changed in this build:**", "", blockquote(input.changeDescription));
  }
  return lines.join("\n");
}

function summarySection(run: RunSummary, pages: PageVerdict[]): string {
  const counts: [string, number][] = [
    ["❌ Real bugs", run.realBugs],
    ["⚠️ Uncertain", run.uncertain],
    ["⚠️ Couldn't be judged", run.judgeErrors],
    ["⚠️ Changed but not judged", run.notJudged],
    ["⚠️ Not compared", run.skipped],
    ["✅ Acceptable changes", run.acceptableChanges],
    ["✅ Unchanged", run.screenshots.unchanged],
  ];
  const countRows = counts.filter(([, n]) => n > 0).map(([label, n]) => `| ${label} | ${n} |`);

  const sorted = sortByStatus(pages);
  const pageRows = sorted.map((p) => {
    const target = p.status === "pass" ? "passing-pages" : anchorFor(p.page);
    const s = STATUS[p.status];
    return `| [${cell(p.page)}](#${target}) | ${s.mark} ${s.word} | ${cell(p.summary)} |`;
  });

  const parts = ["## Summary"];
  if (countRows.length > 0) {
    parts.push(["| Screenshots | Count |", "|---|---:|", ...countRows].join("\n"));
  }
  if (pageRows.length > 0) {
    parts.push(["| Page | Status | Summary |", "|---|---|---|", ...pageRows].join("\n"));
  } else {
    parts.push("_Nothing was compared._");
  }
  return parts.join("\n\n");
}

function sortByStatus<T extends { status: PageStatus }>(items: T[]): T[] {
  // Array.prototype.sort is stable, so equal statuses keep capture order.
  return [...items].sort((a, b) => RANK[a.status] - RANK[b.status]);
}

function imagesTable(result: DiffResult, reportDir: string): string {
  const img = (path: string, kind: string) => {
    const link = relativeLink(reportDir, path);
    const alt = `${result.page} ${result.viewport} ${kind}`.replace(/"/g, "");
    return `[<img src="${link}" width="${IMAGE_WIDTH}" alt="${alt}">](${link})`;
  };
  return [
    "| Baseline | Current | Diff |",
    "|---|---|---|",
    `| ${img(result.baselineImagePath, "baseline")} | ${img(result.currentImagePath, "current")} | ${img(result.diffImagePath, "diff")} |`,
  ].join("\n");
}

function viewportHeading(result: DiffResult): string {
  const conf = result.confidence !== undefined ? ` (${result.confidence}/10)` : "";
  let label: string;
  if (result.judgeError) label = "Couldn't be judged";
  else if (result.verdict) label = `${result.verdict}${conf}`;
  else label = "Changed (not judged)";
  return `#### ${escapeMarkdown(result.viewport)} — ${label}`;
}

function viewportBlock(result: DiffResult, reportDir: string): string {
  const facts = [
    `- **Changed:** ${percent(result.percentChanged)} of the page (${count(result.pixelDiffCount, "pixel")})`,
  ];
  if (result.sizeChanged) {
    const { baselineSize: b, currentSize: c } = result;
    const changes: string[] = [];
    if (b.width !== c.width) changes.push(`width ${b.width}px → ${c.width}px`);
    if (b.height !== c.height) changes.push(`height ${b.height}px → ${c.height}px`);
    facts.push(`- **Page size:** ${changes.join(", ")}`);
  }
  const ignored = [...new Set((result.ignoredRegions ?? []).map((r) => r.label))];
  if (ignored.length > 0) {
    facts.push(`- **Ignored regions:** ${escapeMarkdown(ignored.join(", "))}`);
  }

  const parts = [viewportHeading(result), facts.join("\n")];
  if (result.judgeError) {
    parts.push(blockquote(result.judgeError));
  } else if (result.verdict && result.explanation) {
    parts.push(blockquote(result.explanation));
  }
  if (!result.judgeError && result.observedChanges && result.observedChanges.length > 0) {
    parts.push(
      "**What the judge saw:**",
      result.observedChanges.map((c) => `- ${escapeMarkdown(c)}`).join("\n")
    );
  }
  parts.push(imagesTable(result, reportDir));
  return parts.join("\n\n");
}

function pageSection(
  page: PageVerdict,
  results: DiffResult[],
  skipped: SkippedScreenshot[],
  reportDir: string
): string {
  const s = STATUS[page.status];
  const parts = [
    `### ${escapeMarkdown(page.page)}`,
    `**${s.mark} ${s.word}** · _${cell(page.summary)}_`,
  ];

  // Changed or not-compared viewports, worst first; unchanged ones listed at the end.
  const blocks = page.viewports
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome.changed || outcome.reason.startsWith("not compared"))
    .sort((a, b) => RANK[a.outcome.status] - RANK[b.outcome.status] || a.index - b.index);

  for (const { outcome } of blocks) {
    const result = results.find((r) => r.page === page.page && r.viewport === outcome.viewport);
    if (result && result.changed) {
      parts.push(viewportBlock(result, reportDir));
    } else {
      const skip = skipped.find((x) => x.page === page.page && x.viewport === outcome.viewport);
      parts.push(
        `#### ${escapeMarkdown(outcome.viewport)} — Not compared`,
        `- ${escapeMarkdown(skip?.reason ?? outcome.reason)}`
      );
    }
  }

  const unchanged = page.viewports
    .filter((v) => !v.changed && v.status === "pass")
    .map((v) => escapeMarkdown(v.viewport));
  if (unchanged.length > 0) parts.push(`Unchanged: ${listWords(unchanged)}.`);

  return parts.join("\n\n");
}

function footer(input: MarkdownReportInput): string {
  let line = `Generated by [pixelguard](${PROJECT_URL})`;
  if (input.jsonPath)
    line += ` · JSON results: \`${relativeLink(input.reportDir, input.jsonPath)}\``;
  return `---\n\n${line}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Builds the full Markdown report (see docs/REPORT_TEMPLATE.md). */
export function generateMarkdownReport(input: MarkdownReportInput): string {
  const skipped = input.skipped ?? [];
  const run = summarizeRun(input.results, skipped);
  const pages = rollupPages(input.results, skipped);

  const sections = [
    "# pixelguard report",
    banner(run),
    runDetails(input),
    summarySection(run, pages),
  ];

  const byStatus = (status: PageStatus) => pages.filter((p) => p.status === status);
  const failing = byStatus("fail");
  const review = byStatus("review");
  const passing = byStatus("pass");

  if (failing.length > 0) {
    sections.push("## Failing pages");
    for (const p of failing) sections.push(pageSection(p, input.results, skipped, input.reportDir));
  }
  if (review.length > 0) {
    sections.push("## Pages to review");
    for (const p of review) sections.push(pageSection(p, input.results, skipped, input.reportDir));
  }
  if (passing.length > 0) {
    sections.push(
      "## Passing pages",
      [
        "| Page | Summary |",
        "|---|---|",
        ...passing.map((p) => `| ${cell(p.page)} | ${cell(p.summary)} |`),
      ].join("\n")
    );
  }

  sections.push(footer(input));
  return sections.join("\n\n") + "\n";
}

/** Writes the report to path, creating parent folders as needed. */
export async function writeReport(content: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
