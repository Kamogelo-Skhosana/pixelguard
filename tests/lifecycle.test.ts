/**
 * The final end-to-end pass: one story through all three phases, with
 * everything real (browser, screenshots, diff engine, SQLite, HTTP
 * dashboard, baseline files) except the AI, which is the scripted demo judge.
 *
 *   Phase 1  capture -> capture -> diff: nothing changed (the live clock is ignored)
 *   Phase 2  ship v2 -> capture -> diff --judge: the date is fine, pricing is a Real Bug
 *   Phase 3  dashboard shows the run -> accept the home page -> re-diff: only pricing left
 *            -> accept everything -> re-diff passes -> restore the original -> changes return
 *            -> read-only dashboard refuses changes -> the run page renders in a browser
 *
 * Ticket: P050
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedDemoJudge } from "../examples/demo-site/scriptedJudge.js";
import { startDemoSite, type DemoSite } from "../examples/demo-site/site.js";
import { closeBrowser, launchBrowser } from "../src/capture/browser.js";
import { createProgram } from "../src/cli.js";
import { EXIT_CHANGES, EXIT_OK, type CommandIO } from "../src/commands.js";
import { DEFAULT_VIEWPORTS, type Settings } from "../src/config.js";
import { startDashboard, type RunningDashboard } from "../src/dashboard/server.js";
import { PIXELGUARD_VERSION } from "../src/version.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGE = "Updated the 'last updated' date on the homepage.";

let site: DemoSite;
let dir: string;
let settings: Settings;
let dashboard: RunningDashboard;
let judge: ScriptedDemoJudge;

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = { out: (l) => out.push(l), err: (l) => err.push(l), colour: false };
  let code: number | undefined;
  await createProgram({
    io,
    loadSettings: () => settings,
    setExitCode: (c) => {
      code = c;
    },
    createLLM: () => judge,
  }).parseAsync(["node", "pixelguard", ...args]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const diff = (...extra: string[]) =>
  cli(["diff", "--baseline", "baseline", "--current", "current", ...extra]);

/** The bits of API responses this test looks at. */
interface RunList {
  runs: { id: number; status: string }[];
  total: number;
}
interface RunDetail {
  pages: {
    page: string;
    status: string;
    screenshots: {
      viewport: string;
      verdict: string | null;
      judgedBy: string | null;
      images: Record<string, string>;
    }[];
  }[];
}
interface History {
  versions: { version: number; current: boolean }[];
}

async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${dashboard.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? {} : { "content-type": "application/json", origin: dashboard.url },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  site = await startDemoSite({ version: 1 });
  dir = await mkdtemp(join(tmpdir(), "pixelguard-lifecycle-"));
  judge = new ScriptedDemoJudge();
  settings = {
    targetBaseUrl: site.url,
    targetPages: ["/", "/pricing", "/blog"],
    viewports: DEFAULT_VIEWPORTS.filter((v) => v.name !== "tablet"),
    outputDir: join(dir, "screenshots"),
    diffDir: join(dir, "diffs"),
    regionsFile: join(repoRoot, "examples", "demo-site", "pixelguard.regions.json"),
    regionsFileRequired: true,
    llmApiKey: "not-used",
    llmModel: "scripted-demo-judge",
    databaseUrl: `sqlite:${join(dir, "pixelguard.db")}`,
    databasePath: join(dir, "pixelguard.db"),
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    dashboardReadOnly: false,
  };
});

afterAll(async () => {
  await dashboard?.close();
  await site?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pixelguard v1.0 lifecycle (P050)", () => {
  // The steps build on each other, so they run in order and share state.

  it("reports the release version everywhere", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.version).toBe("1.0.0");
    expect(PIXELGUARD_VERSION).toBe(pkg.version);
    const out: string[] = [];
    await createProgram({
      io: { out: (l) => out.push(l), err: () => {}, colour: false },
    })
      .configureOutput({ writeOut: (s) => out.push(s.trim()) })
      .parseAsync(["node", "pixelguard", "--version"])
      .catch(() => {}); // commander exits via an exception for --version
    expect(out).toContain("1.0.0");
  });

  it("Phase 1: captures, and finds nothing changed when nothing did", async () => {
    const baseline = await cli(["capture", "--tag", "baseline"]);
    expect(baseline.code, baseline.err).toBe(EXIT_OK);
    expect(baseline.out).toContain("Saved 6 screenshot(s)");

    const current = await cli(["capture", "--tag", "current"]);
    expect(current.code, current.err).toBe(EXIT_OK);

    const clean = await diff("--fail-on-change");
    expect(clean.code, clean.err + clean.out).toBe(EXIT_OK);
    // The live clock differs between captures but is an ignored region.
    expect(clean.out).toContain("0 of 6 screenshots changed");
    expect(clean.out).toContain("ignored: Live clock");
    expect(clean.out).toContain("Saved as run #1");
  }, 120_000);

  it("Phase 2: the judge tells the harmless change from the real bug", async () => {
    site.setVersion(2);
    const current = await cli(["capture", "--tag", "current"]);
    expect(current.code, current.err).toBe(EXIT_OK);

    const judged = await diff(
      "--judge",
      "--fail-on-bug",
      "--change",
      CHANGE,
      "--report",
      join(dir, "report.md")
    );
    expect(judged.code).toBe(EXIT_CHANGES);
    expect(judged.out).toContain("4 of 6 screenshots changed");
    expect(judged.out).toMatch(/✗ pricing\s+FAIL\s+Real Bug on desktop \(9\/10\) and mobile/);
    expect(judged.out).toMatch(/✓ home\s+PASS\s+Acceptable changes on desktop and mobile/);
    expect(judged.out).toMatch(/✓ blog\s+PASS\s+No changes/);
    expect(judged.err).toContain("Failing because the judge found 2 real bug(s) on 1 page(s).");
    // Only the 4 changed screenshots were sent to the judge.
    expect(judge.calls.sort()).toEqual([
      "home / desktop",
      "home / mobile",
      "pricing / desktop",
      "pricing / mobile",
    ]);

    const report = await readFile(join(dir, "report.md"), "utf8");
    expect(report).toContain("**FAIL:** 2 real bugs on 1 page, 2 acceptable changes");
    expect(report).toContain("What changed in this build");
  }, 120_000);

  it("Phase 3: the dashboard serves the history, the run and its images", async () => {
    dashboard = await startDashboard({
      databasePath: settings.databasePath,
      outputDir: settings.outputDir,
      host: "127.0.0.1",
      port: 0,
    });

    const health = await api("/api/health");
    expect(health.body).toMatchObject({ status: "ok", version: "1.0.0", runs: 2, readOnly: false });

    const runs = await api<RunList>("/api/runs");
    expect(runs.body.runs.map((r) => [r.id, r.status])).toEqual([
      [2, "fail"],
      [1, "pass"],
    ]);

    const detail = await api<RunDetail>("/api/runs/2");
    const pricing = detail.body.pages.find((p) => p.page === "pricing")!;
    expect(pricing.status).toBe("fail");
    const shot = pricing.screenshots.find((s) => s.viewport === "desktop")!;
    expect(shot).toMatchObject({ verdict: "Real Bug", judgedBy: "scripted-demo-judge" });
    for (const kind of ["baseline", "current", "diff"]) {
      const res = await fetch(`${dashboard.url}${shot.images[kind]}`);
      expect(res.status, kind).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }

    const trend = await api("/api/runs/trend?period=run");
    expect(trend.body.totals).toMatchObject({ runs: 2, failedRuns: 1, realBugs: 2 });
  });

  it("Phase 3: the run page renders in a real browser", async () => {
    let browser: Browser | undefined;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${dashboard.url}/#/runs/2`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-page="pricing"] .shot');
      await expect(page.locator("h1").textContent()).resolves.toContain("Run #2");
      await expect(
        page.locator('[data-page="pricing"] [data-viewport="desktop"] .badge').textContent()
      ).resolves.toBe("Real Bug (9/10)");
      // Screenshots from the run load (not the "no longer available" placeholder).
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-page="pricing"] img')].filter(
            (i) => (i as HTMLImageElement).naturalWidth > 0
          ).length >= 3,
        undefined,
        { timeout: 15_000 }
      );
      expect(errors).toEqual([]);
    } finally {
      if (browser) await closeBrowser(browser);
    }
  }, 60_000);

  it("Phase 3: accepting the intended change leaves only the bug", async () => {
    const accepted = await api("/api/runs/2/accept", { pages: ["home"] });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    // Version 1 is the original baseline; this accept is version 2.
    expect(accepted.body.accepted).toMatchObject({ pages: ["home"], version: 2 });

    judge.calls.length = 0;
    const rerun = await diff("--judge", "--fail-on-bug");
    expect(rerun.code).toBe(EXIT_CHANGES);
    expect(rerun.out).toContain("2 of 6 screenshots changed");
    expect(judge.calls.sort()).toEqual(["pricing / desktop", "pricing / mobile"]);
    expect(rerun.out).toMatch(/✓ home\s+PASS\s+No changes/);
  }, 60_000);

  it("Phase 3: accepting everything makes the next diff pass", async () => {
    const accepted = await api("/api/runs/3/accept", {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.accepted).toMatchObject({ wholeCapture: true, version: 3 });

    const clean = await diff("--fail-on-change");
    expect(clean.code, clean.out).toBe(EXIT_OK);
    expect(clean.out).toContain("0 of 6 screenshots changed");
  }, 60_000);

  it("Phase 3: restoring the original baseline brings the changes back", async () => {
    const history = await api<History>("/api/baselines/baseline/history");
    expect(history.body.versions.map((v) => [v.version, v.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);

    const restored = await api("/api/baselines/baseline/restore", { version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.restored).toMatchObject({ fromVersion: 1, version: 4 });

    const again = await diff();
    expect(again.out).toContain("4 of 6 screenshots changed");

    const cliHistory = await cli(["baseline", "history"]);
    expect(cliHistory.code).toBe(EXIT_OK);
    expect(cliHistory.out).toContain("restored from version 1");
  }, 60_000);

  it("Phase 3: a read-only dashboard shows everything but changes nothing", async () => {
    const readOnly = await startDashboard({
      databasePath: settings.databasePath,
      outputDir: settings.outputDir,
      host: "127.0.0.1",
      port: 0,
      readOnly: true,
    });
    try {
      const runs = await fetch(`${readOnly.url}/api/runs`);
      expect(((await runs.json()) as RunList).total).toBe(5);
      const refused = await fetch(`${readOnly.url}/api/runs/2/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("read_only");
    } finally {
      await readOnly.close();
    }
  });
});
