/**
 * Tests for JSON export of diff results.
 *
 * Ticket: P017
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffResult } from "../src/diff/models.js";
import {
  buildJsonReport,
  exportJson,
  JSON_REPORT_SCHEMA_VERSION,
  readJsonReport,
  summarizeDiffs,
} from "../src/report/jsonExport.js";

function result(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    page: "home",
    viewport: "desktop",
    pixelDiffCount: 0,
    totalPixels: 1000,
    percentChanged: 0,
    changed: false,
    sizeChanged: false,
    baselineSize: { width: 100, height: 10 },
    currentSize: { width: 100, height: 10 },
    diffImagePath: "diffs/desktop/home.png",
    baselineImagePath: "screenshots/baseline/desktop/home.png",
    currentImagePath: "screenshots/current/desktop/home.png",
    ...overrides,
  };
}

const results = [
  result({ pixelDiffCount: 10, percentChanged: 1, changed: true }),
  result({ viewport: "mobile" }),
  result({
    page: "about",
    pixelDiffCount: 200,
    percentChanged: 20,
    changed: true,
    sizeChanged: true,
    currentSize: { width: 100, height: 12 },
  }),
];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-json-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("summarizeDiffs", () => {
  it("counts changes and finds the biggest", () => {
    expect(summarizeDiffs(results)).toEqual({
      total: 3,
      changed: 2,
      unchanged: 1,
      sizeChanged: 1,
      biggestChange: { page: "about", viewport: "desktop", percentChanged: 20 },
    });
  });

  it("has no biggest change when nothing changed", () => {
    expect(summarizeDiffs([result()]).biggestChange).toBeNull();
    expect(summarizeDiffs([])).toMatchObject({ total: 0, changed: 0, biggestChange: null });
  });
});

describe("buildJsonReport", () => {
  it("includes schema version, timestamp, metadata, summary and results", () => {
    const report = buildJsonReport(results, {
      baselineTag: "baseline",
      currentTag: "current",
      targetUrl: "https://example.com",
      changeDescription: "New footer",
      generatedAt: new Date("2026-09-24T21:00:00.000Z"),
    });
    expect(report).toEqual({
      schemaVersion: JSON_REPORT_SCHEMA_VERSION,
      generatedAt: "2026-09-24T21:00:00.000Z",
      baselineTag: "baseline",
      currentTag: "current",
      targetUrl: "https://example.com",
      changeDescription: "New footer",
      summary: summarizeDiffs(results),
      results,
    });
  });

  it("leaves out metadata that wasn't given", () => {
    const report = buildJsonReport([]);
    expect(Object.keys(report).sort()).toEqual([
      "generatedAt",
      "results",
      "schemaVersion",
      "summary",
    ]);
  });
});

describe("exportJson", () => {
  it("writes pretty-printed JSON, creating folders, and returns the report", async () => {
    const path = join(dir, "reports", "nested", "diffs.json");
    const written = await exportJson(results, path, { baselineTag: "baseline" });

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('\n  "schemaVersion": 1,');
    expect(JSON.parse(raw)).toEqual(written);
  });

  it("keeps verdict fields in the JSON (P024)", async () => {
    const path = join(dir, "judged.json");
    const judged = result({
      changed: true,
      verdict: "Acceptable Change",
      confidence: 9,
      explanation: "Matches the new footer.",
      observedChanges: ["Footer links reordered"],
      judgedBy: "claude-sonnet-5",
    });
    await exportJson([judged], path);
    expect((await readJsonReport(path)).results[0]).toEqual(judged);
  });

  it("round-trips through readJsonReport", async () => {
    const path = join(dir, "roundtrip.json");
    const written = await exportJson(results, path, { currentTag: "current" });
    expect(await readJsonReport(path)).toEqual(written);
  });
});

describe("readJsonReport", () => {
  it("rejects files that aren't pixelguard reports", async () => {
    const path = join(dir, "other.json");
    await writeFile(path, JSON.stringify({ hello: "world" }));
    await expect(readJsonReport(path)).rejects.toThrow(/not a pixelguard JSON report/);
  });

  it("explains invalid JSON and missing files", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ nope");
    await expect(readJsonReport(bad)).rejects.toThrow(/Could not read JSON report/);
    await expect(readJsonReport(join(dir, "missing.json"))).rejects.toThrow(
      /Could not read JSON report/
    );
  });
});
