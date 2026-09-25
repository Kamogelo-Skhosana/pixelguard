/**
 * End-to-end test of the whole pipeline against the demo site:
 *
 *   capture baseline (v1) -> site changes (v2) -> capture current
 *   -> diff -> AI judgment -> page rollup -> Markdown report + JSON + database
 *
 * Everything is real (browser, screenshots, diff engine, regions, report,
 * SQLite) except the LLM, which is mocked so CI needs no API key. The mock
 * answers the way a correct judge should for each page; `npm run demo`
 * runs the same flow with the real model.
 *
 * Ticket: P034
 */

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite, type DemoSite } from "../examples/demo-site/site.js";
import { createProgram } from "../src/cli.js";
import { EXIT_CHANGES, EXIT_OK, type CommandIO } from "../src/commands.js";
import { DEFAULT_VIEWPORTS, type Settings } from "../src/config.js";
import { readJsonReport, type JsonReport } from "../src/report/jsonExport.js";
import { getDatabase, loadRun } from "../src/report/persistence.js";
import { MockLLM, verdictReply } from "./helpers/mockLLM.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGE = "Updated the 'last updated' date on the homepage.";

let site: DemoSite;
let dir: string;
let settings: Settings;
let llm: MockLLM;
let diffRun: { code?: number; out: string; err: string };
let report: string;
let json: JsonReport;

async function cli(args: string[], overrides: Partial<Settings> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = { out: (l) => out.push(l), err: (l) => err.push(l), colour: false };
  let code: number | undefined;
  await createProgram({
    io,
    loadSettings: () => ({ ...settings, ...overrides }),
    setExitCode: (c) => {
      code = c;
    },
    createLLM: () => llm,
    now: () => new Date("2026-09-25T10:00:00.000Z"),
  }).parseAsync(["node", "pixelguard", ...args]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeAll(async () => {
  site = await startDemoSite({ version: 1 });
  dir = await mkdtemp(join(tmpdir(), "pixelguard-e2e-"));
  settings = {
    targetBaseUrl: site.url,
    targetPages: ["/", "/pricing", "/blog"],
    viewports: DEFAULT_VIEWPORTS.filter((v) => v.name !== "tablet"),
    outputDir: join(dir, "screenshots"),
    diffDir: join(dir, "diffs"),
    regionsFile: join(repoRoot, "examples", "demo-site", "pixelguard.regions.json"),
    regionsFileRequired: true,
    llmApiKey: "not-used",
    llmModel: "mock-model",
    databaseUrl: `sqlite:${join(dir, "pixelguard.db")}`,
    databasePath: join(dir, "pixelguard.db"),
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    dashboardReadOnly: false,
  };
  // A correct judge: the date change is fine, the pricing layout is broken.
  llm = new MockLLM((call) => {
    const page = call.target.split(" / ")[0];
    if (page === "pricing") {
      return verdictReply(
        "Real Bug",
        9,
        "The pricing cards overlap and their borders cut through the prices.",
        ["Pricing cards overlap"]
      );
    }
    if (page === "home") {
      return verdictReply(
        "Acceptable Change",
        9,
        "Only the 'last updated' date changed, as described."
      );
    }
    return verdictReply("Uncertain", 3, "Unexpected change.");
  });

  const baseline = await cli(["capture", "--tag", "baseline"]);
  expect(baseline.code, baseline.err).toBe(EXIT_OK);

  site.setVersion(2);
  const current = await cli(["capture", "--tag", "current"]);
  expect(current.code, current.err).toBe(EXIT_OK);

  diffRun = await cli([
    "diff",
    "--baseline",
    "baseline",
    "--current",
    "current",
    "--judge",
    "--fail-on-bug",
    "--change",
    CHANGE,
    "--output",
    join(dir, "out", "diffs.json"),
    "--report",
    join(dir, "out", "report.md"),
  ]);
  report = await readFile(join(dir, "out", "report.md"), "utf8");
  json = await readJsonReport(join(dir, "out", "diffs.json"));
}, 120_000);

afterAll(async () => {
  await site?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("full pipeline against the demo site (P034)", () => {
  it("fails the run because of the pricing bug (--fail-on-bug)", () => {
    expect(diffRun.code).toBe(EXIT_CHANGES);
    expect(diffRun.out).toContain(
      "✗ FAIL: 2 real bugs on 1 page, 2 acceptable changes (3 pages checked)"
    );
    expect(diffRun.err).toContain("Failing because the judge found 2 real bug(s) on 1 page(s).");
  });

  it("finds exactly the changes that were made — the live clock is ignored", () => {
    const changed = json.results.filter((r) => r.changed).map((r) => `${r.page}/${r.viewport}`);
    expect(changed.sort()).toEqual(
      ["home/desktop", "home/mobile", "pricing/desktop", "pricing/mobile"].sort()
    );
    const blog = json.results.filter((r) => r.page === "blog");
    expect(blog.every((r) => !r.changed && r.ignoredRegions?.[0]?.label === "Live clock")).toBe(
      true
    );
  });

  it("only sends changed screenshots to the judge, with real images and context", () => {
    expect(llm.calls.map((c) => c.target).sort()).toEqual([
      "home / desktop",
      "home / mobile",
      "pricing / desktop",
      "pricing / mobile",
    ]);
    for (const call of llm.calls) {
      for (const data of [call.images.baseline, call.images.current, call.images.diff]) {
        const png = PNG.sync.read(Buffer.from(data, "base64"));
        expect(png.width).toBeGreaterThan(300);
      }
      expect(call.prompt.user).toContain(CHANGE);
      expect(call.prompt.user).toMatch(/Live clock at x=\d+/);
    }
  });

  it("rolls pages up correctly", () => {
    expect(json.pages.map((p) => [p.page, p.status])).toEqual([
      ["home", "pass"],
      ["pricing", "fail"],
      ["blog", "pass"],
    ]);
    expect(json.run).toMatchObject({ status: "fail", realBugs: 2, acceptableChanges: 2 });
    expect(json.changeDescription).toBe(CHANGE);
  });

  it("writes a Markdown report whose images all exist", async () => {
    expect(report).toContain(
      "> ❌ **FAIL:** 2 real bugs on 1 page, 2 acceptable changes (3 pages checked)"
    );
    expect(report).toContain("## Failing pages\n\n### pricing");
    expect(report).toContain("#### desktop — Real Bug (9/10)");
    expect(report).toContain("- **Ignored regions:** Live clock");
    expect(report).toMatch(/\| home\s*\| Acceptable changes on desktop and mobile \|/);
    expect(report).toMatch(/\| blog\s*\| No changes \|/);

    const links = [...report.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toHaveLength(6); // pricing: 2 viewports x baseline/current/diff
    for (const link of links) {
      await expect(access(resolve(dir, "out", decodeURIComponent(link)))).resolves.toBeUndefined();
    }
  });

  it("saves the run to the database, matching the JSON", () => {
    const db = getDatabase(settings.databasePath);
    const saved = loadRun(db, 1)!;
    db.close();
    expect(saved.run).toMatchObject({
      status: "fail",
      real_bugs: json.run.realBugs,
      acceptable_changes: json.run.acceptableChanges,
      judge_model: "mock-model",
      change_description: CHANGE,
      report_path: join(dir, "out", "report.md"),
    });
    expect(saved.diffs).toHaveLength(json.results.length);
    const pricing = saved.diffs.filter((d) => d.page === "pricing");
    expect(pricing.every((d) => d.verdict === "Real Bug" && d.status === "fail")).toBe(true);
  });

  it("without the regions file, the live clock shows up as a change", async () => {
    const r = await cli(["diff", "--baseline", "baseline", "--current", "current", "--no-save"], {
      regionsFile: join(dir, "no-regions.json"),
      regionsFileRequired: false,
    });
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toMatch(/blog\s+desktop\s+\S+\s+\S+\s+CHANGED/);
  });
});
