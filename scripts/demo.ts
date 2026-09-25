/**
 * pixelguard demo: runs the whole pipeline against the bundled demo site.
 *
 *   npm run demo                          # the whole flow in one go
 *   npm run demo -- --step --dashboard    # for presenting: pause at each step,
 *                                         # then open the dashboard
 *   npm run demo -- --scripted-judge      # rehearse with no internet/API key
 *
 * 1. Starts the demo shop (examples/demo-site) and captures a baseline.
 * 2. Switches the site to version 2: a harmless date change on the home
 *    page, and a real layout bug on the pricing page.
 * 3. Captures again, diffs, and asks the AI judge (when LLM_API_KEY is set,
 *    or the scripted demo judge with --scripted-judge) to tell the trivial
 *    change from the real bug.
 * 4. Writes demo-output/report.md and demo-output/diffs.json and saves the run
 *    to demo-output/pixelguard.db; with --dashboard, serves it.
 *
 * The end-to-end test (tests/e2e.test.ts) runs the same flow.
 * A presenter's walkthrough is in docs/DEMO.md.
 *
 * Tickets: P034, P049
 */

import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { ScriptedDemoJudge, SCRIPTED_JUDGE_MODEL } from "../examples/demo-site/scriptedJudge.js";
import { startDemoSite } from "../examples/demo-site/site.js";
import { createProgram } from "../src/cli.js";
import { EXIT_CHANGES, EXIT_ERROR, EXIT_OK } from "../src/commands.js";
import { loadSettings } from "../src/config.js";
import { startDashboard } from "../src/dashboard/server.js";
import { DEMO_HELP, DemoOptionsError, parseDemoArgs, type DemoOptions } from "./demoOptions.js";

/** Where results go (PIXELGUARD_DEMO_OUT lets tests use a temporary folder). */
const OUT = process.env.PIXELGUARD_DEMO_OUT || "demo-output";
/** Found next to this script, so the demo works from any folder. */
const REGIONS = fileURLToPath(
  new URL("../examples/demo-site/pixelguard.regions.json", import.meta.url)
);
const CHANGE = "Updated the 'last updated' date on the homepage.";

/** Waits for Enter when presenting (--step) in a real terminal. */
async function pause(options: DemoOptions, next: string): Promise<void> {
  if (!options.step || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n  ▸ Press Enter to ${next}… `);
  rl.close();
}

/** Keeps running until Ctrl+C (or SIGTERM). */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function main(argv: string[]): Promise<number> {
  let options: DemoOptions;
  try {
    options = parseDemoArgs(argv);
  } catch (err) {
    if (err instanceof DemoOptionsError) {
      console.error(err.message);
      return EXIT_ERROR;
    }
    throw err;
  }
  if (options.help) {
    console.log(DEMO_HELP);
    return EXIT_OK;
  }
  if (options.step && !process.stdin.isTTY) {
    console.log("(--step needs an interactive terminal; running without pauses.)");
  }

  await rm(OUT, { recursive: true, force: true });
  const site = await startDemoSite({ version: 1 });

  try {
    const settings = loadSettings({
      ...process.env,
      TARGET_BASE_URL: site.url,
      TARGET_PAGES: "/,/pricing,/blog",
      VIEWPORTS: "desktop:1440x900,mobile:390x844",
      OUTPUT_DIR: `${OUT}/screenshots`,
      DIFF_DIR: `${OUT}/diffs`,
      REGIONS_FILE: REGIONS,
      DATABASE_URL: `sqlite:${OUT}/pixelguard.db`,
    });
    const judge: "ai" | "scripted" | "none" = options.scriptedJudge
      ? "scripted"
      : settings.llmApiKey.trim() !== ""
        ? "ai"
        : "none";

    let code = EXIT_OK;
    const run = async (title: string, args: string[]) => {
      console.log(`\n=== ${title} ===\n`);
      await createProgram({
        loadSettings: () => settings,
        setExitCode: (c) => {
          code = c;
        },
        ...(judge === "scripted" && { createLLM: () => new ScriptedDemoJudge() }),
      }).parseAsync(["node", "pixelguard", ...args]);
      return code;
    };

    console.log(`pixelguard demo. The demo shop is running at ${site.url}`);
    console.log(
      `  Version 1: ${site.url}/pricing?version=1   Version 2: ${site.url}/pricing?version=2`
    );
    if (judge === "scripted") {
      console.log(
        `\nUsing the scripted demo judge ("${SCRIPTED_JUDGE_MODEL}"), not the AI: its verdicts are\n` +
          "pre-written for this demo site. Set LLM_API_KEY and drop --scripted-judge for the real thing."
      );
    }

    await pause(options, "capture the baseline (version 1 of the shop)");
    if (
      (await run("1. Capture the baseline (version 1)", ["capture", "--tag", "baseline"])) !==
      EXIT_OK
    ) {
      return EXIT_ERROR;
    }

    await pause(options, "ship version 2 (a date change and a CSS mistake) and capture it");
    site.setVersion(2);
    console.log("\nDemo site switched to version 2: new date on home, broken layout on pricing.");
    if (
      (await run("2. Capture the current version", ["capture", "--tag", "current"])) !== EXIT_OK
    ) {
      return EXIT_ERROR;
    }

    if (judge === "none") {
      console.log(
        "\nLLM_API_KEY isn't set, so the AI judge is skipped. Add your Anthropic API key to .env\n" +
          "to see pixelguard tell the harmless date change from the real pricing bug\n" +
          "(or rehearse offline with: npm run demo -- --scripted-judge)."
      );
    }
    await pause(options, judge === "none" ? "diff the two versions" : "diff and judge");
    const diffCode = await run(`3. Diff${judge === "none" ? "" : " and judge"}`, [
      "diff",
      "--baseline",
      "baseline",
      "--current",
      "current",
      "--change",
      CHANGE,
      "--output",
      `${OUT}/diffs.json`,
      "--report",
      `${OUT}/report.md`,
      ...(judge === "none" ? [] : ["--judge"]),
    ]);

    console.log(`\nDone. Open ${OUT}/report.md to see the report.`);
    if (judge !== "none") {
      console.log(
        "Expected: home = Acceptable Change (the date), pricing = Real Bug (overlapping cards), blog = no changes."
      );
    }
    if (diffCode !== EXIT_OK && diffCode !== EXIT_CHANGES) return diffCode;

    if (options.dashboard) {
      await pause(options, "open the dashboard");
      const dashboard = await startDashboard({
        databasePath: settings.databasePath,
        outputDir: settings.outputDir,
        host: "127.0.0.1",
        port: options.port,
      });
      console.log(`\n=== 4. Dashboard ===\n`);
      console.log(`Dashboard:  ${dashboard.url}/#/runs/1`);
      console.log(`Demo shop:  ${site.url}  (add ?version=1 or ?version=2 to compare)`);
      console.log("Press Ctrl+C to stop.");
      await untilStopped();
      await dashboard.close();
    } else {
      console.log(`Browse it in the dashboard: npm run demo -- --dashboard`);
    }
    return EXIT_OK;
  } finally {
    await site.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_ERROR;
  }
);
