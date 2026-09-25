/**
 * Implementation of the `pixelguard capture`, `diff` and `dashboard` commands.
 *
 * Kept separate from cli.ts (argument parsing) so the commands can be tested
 * directly. Each returns a process exit code:
 *
 *   0 — success
 *   1 — changes were found with --fail-on-change, or a Real Bug with --fail-on-bug (diff only)
 *   2 — something went wrong (bad config, failed screenshots, missing capture, ...)
 *
 * Ticket: P015
 */

import { captureAllPages, type PageCaptureResult } from "./capture/capture.js";
import type { Settings } from "./config.js";
import type { CompareOptions } from "./diff/imageCompare.js";
import { diffTags } from "./diff/runDiff.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  loadDynamicRegions,
  normalizeChangeDescription,
  type ChangeContext,
  type DynamicRegion,
} from "./judge/context.js";
import { judgeDiffs } from "./judge/judge.js";
import { createLLMClient, type LLMClient } from "./judge/llmClient.js";
import { rollupPages, summarizeRun } from "./judge/aggregate.js";
import {
  describeVerdict,
  formatDiffResults,
  formatPageVerdicts,
  formatPercent,
  formatRunSummary,
} from "./report/console.js";
import { exportJson } from "./report/jsonExport.js";
import { generateMarkdownReport, writeReport } from "./report/markdown.js";
import { getDatabase, saveRun } from "./report/persistence.js";
import { startDashboard, type RunningDashboard } from "./dashboard/server.js";

export const EXIT_OK = 0;
export const EXIT_CHANGES = 1;
export const EXIT_ERROR = 2;

export interface CommandIO {
  out: (line: string) => void;
  err: (line: string) => void;
  colour: boolean;
}

export const consoleIO = (colour: boolean): CommandIO => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  colour,
});

/** Loads the regions file, printing how many regions were found. */
async function loadRegions(settings: Settings, io: CommandIO): Promise<DynamicRegion[]> {
  const regions = await loadDynamicRegions(settings.regionsFile, {
    required: settings.regionsFileRequired,
  });
  if (regions.length > 0) {
    io.out(`Using ${regions.length} known dynamic region(s) from ${settings.regionsFile}`);
  }
  return regions;
}

export interface CaptureCommandOptions {
  tag: string;
}

export async function runCapture(
  settings: Settings,
  options: CaptureCommandOptions,
  io: CommandIO
): Promise<number> {
  const { targetBaseUrl, targetPages, viewports, outputDir } = settings;

  let regions: DynamicRegion[];
  try {
    regions = await loadRegions(settings, io);
  } catch (err) {
    io.err((err as Error).message);
    return EXIT_ERROR;
  }

  io.out(
    `Capturing ${targetPages.length} page(s) x ${viewports.length} viewport(s) ` +
      `from ${targetBaseUrl} as "${options.tag}"...`
  );

  const onPage = (page: PageCaptureResult) => {
    const ok = page.viewports.filter((v) => v.ok).map((v) => v.viewport);
    const failed = page.viewports.filter((v) => !v.ok);
    const mark = failed.length === 0 ? "✓" : ok.length === 0 ? "✗" : "!";
    let line = `  ${mark} ${page.page}`;
    if (ok.length > 0) line += `  ${ok.join(", ")}`;
    io.out(line);
    for (const f of failed) {
      if (!f.ok) io.err(`      ${f.viewport}: ${f.error.message}`);
    }
  };

  try {
    const run = await captureAllPages({
      baseUrl: targetBaseUrl,
      pages: targetPages,
      viewports,
      outputDir,
      tag: options.tag,
      onPage,
      regions,
    });
    io.out("");
    io.out(`Saved ${run.succeeded} screenshot(s) to ${run.dir}`);
    if (run.failed > 0) {
      io.err(`${run.failed} screenshot(s) failed — see above.`);
      return EXIT_ERROR;
    }
    return EXIT_OK;
  } catch (err) {
    io.err(`Capture failed: ${(err as Error).message}`);
    return EXIT_ERROR;
  }
}

export interface DiffCommandOptions {
  baseline: string;
  current: string;
  /** Write the JSON report here. */
  output?: string;
  /** Write the Markdown report here (P031). */
  report?: string;
  /** Save the run to the database (default: true; --no-save turns it off) (P033). */
  save?: boolean;
  threshold?: number;
  failOnChange?: boolean;
  /** Short description of what changed in this build (P020). */
  change?: string;
  /** File containing the change description (alternative to change). */
  changeFile?: string;
  /** Ask the AI judge for a verdict on every changed screenshot (P023). */
  judge?: boolean;
  /** Exit with code 1 if the judge found a Real Bug (needs judge). */
  failOnBug?: boolean;
}

export interface DiffCommandDeps {
  /** Creates the LLM client used by --judge (tests pass a fake). */
  createLLM?: (settings: Settings) => LLMClient;
  /** Current time, for the report's "Generated" line (tests pass a fixed date). */
  now?: () => Date;
}

/** Reads the change description from --change or --change-file. */
export async function resolveChangeDescription(options: {
  change?: string;
  changeFile?: string;
}): Promise<string> {
  if (options.change !== undefined && options.changeFile !== undefined) {
    throw new Error("Use either --change or --change-file, not both.");
  }
  if (options.changeFile !== undefined) {
    let text: string;
    try {
      text = await readFile(options.changeFile, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read --change-file ${options.changeFile}: ${(err as Error).message}`
      );
    }
    return normalizeChangeDescription(text);
  }
  return normalizeChangeDescription(options.change);
}

export async function runDiff(
  settings: Settings,
  options: DiffCommandOptions,
  io: CommandIO,
  deps: DiffCommandDeps = {}
): Promise<number> {
  const compare: CompareOptions = {};
  if (options.threshold !== undefined) compare.threshold = options.threshold;

  if (options.failOnBug && !options.judge) {
    io.err("--fail-on-bug needs --judge (bugs are found by the AI judge).");
    return EXIT_ERROR;
  }

  // Create the judge up front so a missing API key fails before any work.
  let llm: LLMClient | undefined;
  if (options.judge) {
    try {
      llm = (deps.createLLM ?? createLLMClient)(settings);
    } catch (err) {
      io.err(`Can't use --judge: ${(err as Error).message}`);
      return EXIT_ERROR;
    }
  }

  try {
    const regions = await loadRegions(settings, io);
    const context: ChangeContext = {
      dynamicRegions: regions,
      changeDescription: await resolveChangeDescription(options),
    };
    io.out(`Comparing "${options.baseline}" with "${options.current}"...`);
    if (context.changeDescription) {
      const [first, ...rest] = context.changeDescription.split("\n");
      io.out(`What changed: ${first}${rest.length > 0 ? ` (+${rest.length} more line(s))` : ""}`);
    }
    io.out("");
    const run = await diffTags({
      outputDir: settings.outputDir,
      diffDir: settings.diffDir,
      baselineTag: options.baseline,
      currentTag: options.current,
      compare,
      regions,
    });

    let results = run.results;
    if (llm) {
      const changedCount = results.filter((r) => r.changed).length;
      if (changedCount > 0) {
        io.out(`Judging ${changedCount} changed screenshot(s) with ${llm.model}...`);
        results = await judgeDiffs(results, context, llm, {
          onJudged: (r) => io.out(`  ${r.page} / ${r.viewport}: ${describeVerdict(r)}`),
        });
        io.out("");
      }
    }

    io.out(formatDiffResults(results, { colour: io.colour }));

    // The page rollup and run result are only meaningful once results have verdicts.
    const runSummary = summarizeRun(results, run.skipped);
    if (llm) {
      io.out("");
      io.out(formatPageVerdicts(rollupPages(results, run.skipped), { colour: io.colour }));
      io.out("");
      io.out(formatRunSummary(runSummary, { colour: io.colour }));
    }

    if (run.skipped.length > 0) {
      io.err("");
      io.err(`Skipped ${run.skipped.length} screenshot(s) that couldn't be compared:`);
      for (const s of run.skipped) io.err(`  - ${s.page} / ${s.viewport}: ${s.reason}`);
    }

    if (run.warnings.length > 0) {
      io.err("");
      for (const w of run.warnings) io.err(`Warning: ${w}`);
    }

    if (run.results.length > 0) {
      io.out("");
      io.out(`Diff images: ${run.dir}`);
    }

    if (options.output) {
      await exportJson(results, options.output, {
        baselineTag: options.baseline,
        currentTag: options.current,
        targetUrl: run.targetUrl,
        changeDescription: context.changeDescription,
        skipped: run.skipped,
      });
      io.out(`JSON results: ${options.output}`);
    }

    // Saved before any --fail-on-* exit, like the report. A database problem is
    // reported as a warning so it never hides the results or changes the exit code.
    if (options.save !== false) {
      try {
        const db = getDatabase(settings.databasePath);
        try {
          const runId = saveRun(db, {
            results,
            skipped: run.skipped,
            targetUrl: run.targetUrl,
            baselineTag: options.baseline,
            currentTag: options.current,
            changeDescription: context.changeDescription,
            createdAt: (deps.now ?? (() => new Date()))(),
            reportPath: options.report,
            jsonPath: options.output,
          });
          io.out(`Saved as run #${runId} in ${settings.databasePath}`);
        } finally {
          db.close();
        }
      } catch (err) {
        io.err(`Warning: couldn't save this run to the database: ${(err as Error).message}`);
      }
    }

    // Written before any --fail-on-* exit: failing runs are when the report matters most.
    if (options.report) {
      const report = generateMarkdownReport({
        results,
        skipped: run.skipped,
        targetUrl: run.targetUrl,
        baselineTag: options.baseline,
        currentTag: options.current,
        changeDescription: context.changeDescription,
        generatedAt: (deps.now ?? (() => new Date()))(),
        reportDir: dirname(resolve(options.report)),
        jsonPath: options.output,
      });
      await writeReport(report, options.report);
      io.out(`Markdown report: ${options.report}`);
      if (!llm) {
        io.out("  (run with --judge to add AI verdicts and explanations to the report)");
      }
    }

    if (options.failOnBug && runSummary.status === "fail") {
      io.err(
        `Failing because the judge found ${runSummary.realBugs} real bug(s) on ${runSummary.pages.fail} page(s).`
      );
      return EXIT_CHANGES;
    }

    const changed = results.filter((r) => r.changed);
    if (options.failOnChange && changed.length > 0) {
      const worst = Math.max(...changed.map((r) => r.percentChanged));
      io.err(
        `Failing because ${changed.length} screenshot(s) changed (up to ${formatPercent(worst)}).`
      );
      return EXIT_CHANGES;
    }
    return EXIT_OK;
  } catch (err) {
    io.err(`Diff failed: ${(err as Error).message}`);
    return EXIT_ERROR;
  }
}

export interface DashboardCommandOptions {
  port?: number;
  host?: string;
}

export interface DashboardCommandDeps {
  /**
   * Called once the server is up. The CLI waits for Ctrl+C here; tests pass a
   * function that stops the server straight away.
   */
  waitForStop?: (dashboard: RunningDashboard) => Promise<void>;
}

/** Waits for Ctrl+C (or SIGTERM), then stops the dashboard cleanly. */
function waitForSignal(dashboard: RunningDashboard, io: CommandIO): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      io.out("\nStopping the dashboard...");
      void dashboard.close().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export async function runDashboard(
  settings: Settings,
  options: DashboardCommandOptions,
  io: CommandIO,
  deps: DashboardCommandDeps = {}
): Promise<number> {
  let dashboard: RunningDashboard;
  try {
    dashboard = await startDashboard({
      databasePath: settings.databasePath,
      host: options.host ?? settings.dashboardHost,
      port: options.port ?? settings.dashboardPort,
    });
  } catch (err) {
    io.err(`Dashboard failed to start: ${(err as Error).message}`);
    return EXIT_ERROR;
  }

  io.out(`pixelguard dashboard running at ${dashboard.url}`);
  io.out(`Reading runs from ${settings.databasePath}. Press Ctrl+C to stop.`);
  await (deps.waitForStop ?? ((d) => waitForSignal(d, io)))(dashboard);
  return EXIT_OK;
}
