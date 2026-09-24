/**
 * Console output formatter for raw diff results (Phase 1).
 *
 * Prints a table with one row per page/viewport, followed by a summary:
 *
 *   Page   Viewport  Changed  Pixels  Status     Notes
 *   home   desktop    1.25%   4,820  CHANGED
 *   home   mobile        0%       0  unchanged
 *   about  desktop   20.00%  86,400  CHANGED    height 2000px -> 2300px
 *
 *   2 of 3 screenshots changed. Biggest change: about / desktop (20.00%)
 *
 * Ticket: P016
 */

import type { DiffResult } from "../diff/models.js";
import type { PageStatus, PageVerdict } from "../judge/aggregate.js";
import { summarizeDiffs } from "./jsonExport.js";

export interface ConsoleFormatOptions {
  /** Use ANSI colours. Defaults to true when stdout is a terminal and NO_COLOR isn't set. */
  colour?: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

type Style = keyof typeof ANSI;

export function shouldUseColour(): boolean {
  return Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env);
}

/** Formats a percentage for display: "0%", "<0.01%", "1.25%", "100.00%". */
export function formatPercent(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 0.01) return "<0.01%";
  return `${percent.toFixed(2)}%`;
}

/** Formats a pixel count with thousands separators: 1234567 -> "1,234,567". */
export function formatCount(count: number): string {
  return Math.round(count)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Describes how a screenshot's dimensions changed, or "" if they didn't. */
export function describeSizeChange(result: DiffResult): string {
  if (!result.sizeChanged) return "";
  const { baselineSize: b, currentSize: c } = result;
  const parts: string[] = [];
  if (b.width !== c.width) parts.push(`width ${b.width}px -> ${c.width}px`);
  if (b.height !== c.height) parts.push(`height ${b.height}px -> ${c.height}px`);
  return parts.join(", ");
}

/** Verdict column text, e.g. "Real Bug (8/10)", "Uncertain (not judged)", or "". */
export function describeVerdict(result: DiffResult): string {
  if (!result.verdict) return "";
  if (result.judgeError) return `${result.verdict} (not judged)`;
  return result.confidence ? `${result.verdict} (${result.confidence}/10)` : result.verdict;
}

const VERDICT_STYLE: Record<string, Style> = {
  "Real Bug": "red",
  "Acceptable Change": "green",
  Uncertain: "yellow",
};

/** Notes column: size changes and any ignored regions. */
export function describeNotes(result: DiffResult): string {
  const notes: string[] = [];
  const size = describeSizeChange(result);
  if (size) notes.push(size);
  const ignored = [...new Set((result.ignoredRegions ?? []).map((r) => r.label))];
  if (ignored.length > 0) notes.push(`ignored: ${ignored.join(", ")}`);
  return notes.join("; ");
}

interface Cell {
  text: string;
  style?: Style;
  align?: "left" | "right";
}

function paint(text: string, style: Style | undefined, colour: boolean): string {
  return colour && style ? `${ANSI[style]}${text}${ANSI.reset}` : text;
}

/** Builds the full console report as a string (no trailing newline). */
export function formatDiffResults(
  results: DiffResult[],
  options: ConsoleFormatOptions = {}
): string {
  const colour = options.colour ?? shouldUseColour();

  if (results.length === 0) {
    return paint("No screenshots to compare.", "yellow", colour);
  }

  // The Verdict column only appears once results have been judged (Phase 2).
  const showVerdict = results.some((r) => r.verdict !== undefined);

  const header: Cell[] = [
    { text: "Page" },
    { text: "Viewport" },
    { text: "Changed", align: "right" },
    { text: "Pixels", align: "right" },
    { text: "Status" },
    ...(showVerdict ? [{ text: "Verdict" }] : []),
    { text: "Notes" },
  ];

  const rows: Cell[][] = results.map((r) => [
    { text: r.page },
    { text: r.viewport },
    { text: formatPercent(r.percentChanged), align: "right" },
    { text: formatCount(r.pixelDiffCount), align: "right" },
    r.changed ? { text: "CHANGED", style: "red" } : { text: "unchanged", style: "green" },
    ...(showVerdict
      ? [{ text: describeVerdict(r), style: r.verdict ? VERDICT_STYLE[r.verdict] : undefined }]
      : []),
    { text: describeNotes(r), style: "yellow" },
  ]);

  // Column widths are measured on plain text, so colour codes don't break alignment.
  const widths = header.map((h, col) =>
    Math.max(h.text.length, ...rows.map((row) => row[col].text.length))
  );

  const renderRow = (cells: Cell[], rowStyle?: Style) => {
    // Drop empty cells at the end so rows never carry trailing spaces.
    let last = cells.length - 1;
    while (last > 0 && cells[last].text === "") last--;

    return cells
      .slice(0, last + 1)
      .map((cell, col) => {
        // Padding goes outside the colour codes, and the last cell isn't padded.
        const padding = col === last ? "" : " ".repeat(widths[col] - cell.text.length);
        const text = paint(cell.text, rowStyle ?? cell.style, colour);
        return cell.align === "right" ? padding + text : text + padding;
      })
      .join("  ");
  };

  const { total, changed, biggestChange } = summarizeDiffs(results);
  let summary = `${changed} of ${total} screenshot${total === 1 ? "" : "s"} changed.`;
  if (biggestChange) {
    summary += ` Biggest change: ${biggestChange.page} / ${biggestChange.viewport} (${formatPercent(biggestChange.percentChanged)})`;
  }

  return [
    renderRow(header, "bold"),
    ...rows.map((row) => renderRow(row)),
    "",
    paint(summary, changed > 0 ? "red" : "green", colour),
  ].join("\n");
}

export function printDiffResults(results: DiffResult[], options: ConsoleFormatOptions = {}): void {
  console.log(formatDiffResults(results, options));
}

const PAGE_STATUS: Record<PageStatus, { mark: string; label: string; style: Style }> = {
  fail: { mark: "✗", label: "FAIL", style: "red" },
  review: { mark: "?", label: "REVIEW", style: "yellow" },
  pass: { mark: "✓", label: "PASS", style: "green" },
};

/**
 * Formats the per-page rollup (P026), worst pages first:
 *
 *   Pages:
 *     ✗ checkout  FAIL    Real Bug on mobile (9/10)
 *     ? about     REVIEW  Needs review: desktop Uncertain (4/10)
 *     ✓ home      PASS    Acceptable changes on desktop and mobile
 */
export function formatPageVerdicts(
  pages: PageVerdict[],
  options: ConsoleFormatOptions = {}
): string {
  const colour = options.colour ?? shouldUseColour();
  if (pages.length === 0) return "Pages: none";

  const order: PageStatus[] = ["fail", "review", "pass"];
  const sorted = [...pages].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const nameWidth = Math.max(...pages.map((p) => p.page.length));
  const labelWidth = Math.max(...pages.map((p) => PAGE_STATUS[p.status].label.length));

  const lines = sorted.map((p) => {
    const s = PAGE_STATUS[p.status];
    const label = paint(s.label, s.style, colour) + " ".repeat(labelWidth - s.label.length);
    return `  ${paint(s.mark, s.style, colour)} ${p.page.padEnd(nameWidth)}  ${label}  ${p.summary}`;
  });
  return ["Pages:", ...lines].join("\n");
}
