/**
 * pixelguard demo: runs the whole pipeline against the bundled demo site.
 *
 *   npm run demo
 *
 * 1. Starts the demo shop (examples/demo-site) and captures a baseline.
 * 2. Switches the site to version 2: a harmless date change on the home
 *    page, and a real layout bug on the pricing page.
 * 3. Captures again, diffs, and — if LLM_API_KEY is set in .env — asks the
 *    AI judge to tell the trivial change from the real bug.
 * 4. Writes demo-output/report.md, demo-output/diffs.json and saves the run
 *    to demo-output/pixelguard.db.
 *
 * This is the Phase 2 checkpoint run with the real model; the end-to-end
 * test (tests/e2e.test.ts) runs the same flow with a mocked one.
 *
 * Ticket: P034
 */

import { rm } from "node:fs/promises";
import { startDemoSite } from "../examples/demo-site/site.js";
import { createProgram } from "../src/cli.js";
import { EXIT_CHANGES, EXIT_ERROR, EXIT_OK } from "../src/commands.js";
import { loadSettings } from "../src/config.js";

const OUT = "demo-output";
const CHANGE = "Updated the 'last updated' date on the homepage.";

async function main(): Promise<number> {
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
      REGIONS_FILE: "examples/demo-site/pixelguard.regions.json",
      DATABASE_URL: `sqlite:${OUT}/pixelguard.db`,
    });
    const judge = settings.llmApiKey.trim() !== "";

    let code = EXIT_OK;
    const run = async (title: string, args: string[]) => {
      console.log(`\n=== ${title} ===\n`);
      await createProgram({
        loadSettings: () => settings,
        setExitCode: (c) => {
          code = c;
        },
      }).parseAsync(["node", "pixelguard", ...args]);
      return code;
    };

    console.log(`Demo site running at ${site.url}`);
    if (
      (await run("1. Capture the baseline (version 1)", ["capture", "--tag", "baseline"])) !==
      EXIT_OK
    ) {
      return EXIT_ERROR;
    }

    site.setVersion(2);
    console.log("\nDemo site switched to version 2: new date on home, broken layout on pricing.");
    if (
      (await run("2. Capture the current version", ["capture", "--tag", "current"])) !== EXIT_OK
    ) {
      return EXIT_ERROR;
    }

    if (!judge) {
      console.log(
        "\nLLM_API_KEY isn't set, so the AI judge is skipped. Add your Anthropic API key to .env\n" +
          "to see pixelguard tell the harmless date change from the real pricing bug."
      );
    }
    const diffCode = await run(`3. Diff${judge ? " and judge" : ""}`, [
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
      ...(judge ? ["--judge"] : []),
    ]);

    console.log(`\nDone. Open ${OUT}/report.md to see the report.`);
    if (judge) {
      console.log(
        "Expected: home = Acceptable Change (the date), pricing = Real Bug (overlapping cards), blog = no changes."
      );
    }
    return diffCode === EXIT_CHANGES ? EXIT_OK : diffCode;
  } finally {
    await site.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_ERROR;
  }
);
