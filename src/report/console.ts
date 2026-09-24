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

  const header: Cell[] = [
    { text: "Page" },
    { text: "Viewport" },
    { text: "Changed", align: "right" },
    { text: "Pixels", align: "right" },
    { text: "Status" },
    { text: "Notes" },
  ];

  const rows: Cell[][] = results.map((r) => [
    { text: r.page },
    { text: r.viewport },
    { text: formatPercent(r.percentChanged), align: "right" },
    { text: formatCount(r.pixelDiffCount), align: "right" },
    r.changed ? { text: "CHANGED", style: "red" } : { text: "unchanged", style: "green" },
    { text: describeSizeChange(r), style: "yellow" },
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

  const changed = results.filter((r) => r.changed);
  const biggest = changed.reduce<DiffResult | undefined>(
    (max, r) => (!max || r.percentChanged > max.percentChanged ? r : max),
    undefined
  );

  let summary = `${changed.length} of ${results.length} screenshot${results.length === 1 ? "" : "s"} changed.`;
  if (biggest) {
    summary += ` Biggest change: ${biggest.page} / ${biggest.viewport} (${formatPercent(biggest.percentChanged)})`;
  }

  return [
    renderRow(header, "bold"),
    ...rows.map((row) => renderRow(row)),
    "",
    paint(summary, changed.length > 0 ? "red" : "green", colour),
  ].join("\n");
}

export function printDiffResults(results: DiffResult[], options: ConsoleFormatOptions = {}): void {
  console.log(formatDiffResults(results, options));
}
