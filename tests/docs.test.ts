/**
 * Keeps the documentation honest: every relative link and image in the
 * Markdown docs points at a file that exists, and in-page #links match a
 * heading. (The README used to link a LICENSE file that wasn't there.)
 *
 * Ticket: P048
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "examples/README.md",
  "docs/ARCHITECTURE.md",
  "docs/DEPLOYMENT.md",
  "docs/REPORT_TEMPLATE.md",
  "docs/ROADMAP.md",
];

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Markdown links and images outside code: [text](target) and <img src="target">. */
function links(markdown: string): string[] {
  // Code blocks and inline code are examples, not links.
  const prose = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const md = [...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  const html = [...prose.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  return [...md, ...html];
}

describe.each(DOCS)("%s (P048)", (file) => {
  const text = readFileSync(resolve(root, file), "utf8");
  const headings = new Set(
    [...text.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))
  );

  it("links only to files that exist", () => {
    const missing = links(text)
      .filter((l) => !/^(https?:|mailto:|#)/.test(l))
      .map((l) => decodeURIComponent(l.split("#")[0]))
      .filter((target) => !existsSync(resolve(root, dirname(file), target)));
    expect(missing).toEqual([]);
  });

  it("uses in-page anchors that match a heading", () => {
    const broken = links(text)
      .filter((l) => l.startsWith("#"))
      .filter((l) => !headings.has(l.slice(1)));
    expect(broken).toEqual([]);
  });
});

describe("README (P048)", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");

  it("shows the dashboard screenshots", () => {
    for (const image of ["dashboard-run-detail", "dashboard-runs", "dashboard-trend"]) {
      expect(readme).toContain(`docs/images/${image}.png`);
    }
  });

  it("documents every command and every setting in .env.example", () => {
    for (const command of [
      "capture",
      "diff",
      "accept",
      "baseline history",
      "baseline restore",
      "dashboard",
    ]) {
      expect(readme).toContain(`\`${command}`);
    }
    const settings = [
      ...readFileSync(resolve(root, ".env.example"), "utf8").matchAll(/^#?\s?([A-Z_]{4,})=/gm),
    ].map((m) => m[1]);
    expect(settings.length).toBeGreaterThan(5);
    for (const setting of settings) expect(readme).toContain(`\`${setting}\``);
  });

  it("documents every diff option", () => {
    for (const option of [
      "--judge",
      "--change",
      "--change-file",
      "--report",
      "--output",
      "--threshold",
      "--fail-on-change",
      "--fail-on-bug",
      "--no-save",
    ]) {
      expect(readme).toContain(option);
    }
  });
});
