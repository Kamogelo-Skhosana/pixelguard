#!/usr/bin/env node
/**
 * CLI entry point for pixelguard.
 *
 * Usage:
 *   pixelguard capture --tag <name>
 *   pixelguard accept --from <tag> [--to baseline] [--pages home,pricing] [--force]
 *   pixelguard baseline history [--tag baseline]
 *   pixelguard baseline restore <version> [--tag baseline]
 *   pixelguard dashboard [--port 8100] [--host 127.0.0.1] [--read-only]
 *   pixelguard diff --baseline <tag> --current <tag> [--output diffs.json]
 *                   [--threshold 0.1] [--fail-on-change]
 *                   [--change "<what changed>" | --change-file notes.txt] [--judge]
 *                   [--fail-on-bug] [--report report.md] [--no-save]
 *
 * Exit codes: 0 success, 1 changes found with --fail-on-change or a Real Bug
 * with --fail-on-bug, 2 error.
 *
 * Ticket: P015
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import {
  consoleIO,
  EXIT_ERROR,
  runCapture,
  runAccept,
  runBaselineHistory,
  runBaselineRestore,
  runDashboard,
  runDiff,
  type CommandIO,
  type DashboardCommandDeps,
  type DiffCommandDeps,
} from "./commands.js";
import { ConfigError, loadSettings, type Settings } from "./config.js";
import { shouldUseColour } from "./report/console.js";
import { PIXELGUARD_VERSION } from "./version.js";

export interface ProgramDeps extends DiffCommandDeps, DashboardCommandDeps {
  io?: CommandIO;
  loadSettings?: () => Settings;
  /** Receives the command's exit code (defaults to setting process.exitCode). */
  setExitCode?: (code: number) => void;
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n > 65535) {
    throw new InvalidArgumentError("must be a whole number from 0 to 65535.");
  }
  return n;
}

function parseVersion(value: string): number {
  const n = Number(value.replace(/^v/i, ""));
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("must be a version number like 3 or v3.");
  }
  return n;
}

function parseThreshold(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new InvalidArgumentError("must be a number between 0 and 1.");
  }
  return n;
}

export function createProgram(deps: ProgramDeps = {}): Command {
  const io = deps.io ?? consoleIO(shouldUseColour());
  const getSettings = deps.loadSettings ?? (() => loadSettings());
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  /** Loads settings, printing config errors nicely instead of a stack trace. */
  const withSettings = async (fn: (settings: Settings) => Promise<number>) => {
    let settings: Settings;
    try {
      settings = getSettings();
    } catch (err) {
      io.err(err instanceof ConfigError ? err.message : `Error: ${(err as Error).message}`);
      setExitCode(EXIT_ERROR);
      return;
    }
    setExitCode(await fn(settings));
  };

  const program = new Command();
  program
    .name("pixelguard")
    .description("AI-powered visual regression testing agent")
    .version(PIXELGUARD_VERSION)
    // Throw instead of exiting on bad arguments, so they get exit code 2
    // (commander's default of 1 would look like "changes found").
    // Set before adding subcommands so they inherit it.
    .exitOverride();

  program
    .command("capture")
    .description("Capture screenshots of all configured pages/viewports")
    .requiredOption("--tag <name>", "Tag to store this capture under (e.g. baseline, current)")
    .action((opts: { tag: string }) => withSettings((s) => runCapture(s, opts, io)));

  program
    .command("diff")
    .description("Diff a baseline capture against a current capture")
    .requiredOption("--baseline <tag>", "Tag of the baseline capture")
    .requiredOption("--current <tag>", "Tag of the current capture")
    .option("--output <path>", "Write raw diff results as JSON")
    .option("--threshold <number>", "Pixel colour sensitivity, 0-1 (default 0.1)", parseThreshold)
    .option("--fail-on-change", "Exit with code 1 if any screenshot changed (useful in CI)")
    .addOption(
      new Option(
        "--change <text>",
        'Short description of what changed in this build, e.g. "Redesigned the checkout button"'
      ).env("PIXELGUARD_CHANGE")
    )
    .option("--change-file <path>", "Read the change description from a file")
    .option(
      "--judge",
      "Ask the AI judge for a verdict on each changed screenshot (needs LLM_API_KEY)"
    )
    .option(
      "--fail-on-bug",
      "With --judge: exit with code 1 if the judge found a Real Bug (for CI)"
    )
    .option("--report <path>", "Write a Markdown report (with AI verdicts when used with --judge)")
    .option("--no-save", "Don't save this run to the database (DATABASE_URL)")
    .action(
      (
        opts: {
          baseline: string;
          current: string;
          output?: string;
          threshold?: number;
          failOnChange?: boolean;
          report?: string;
          change?: string;
          changeFile?: string;
          judge?: boolean;
          failOnBug?: boolean;
          save?: boolean;
        },
        cmd: Command
      ) => {
        // An explicit --change-file wins over a PIXELGUARD_CHANGE set in the environment.
        if (opts.changeFile !== undefined && cmd.getOptionValueSource("change") === "env") {
          opts = { ...opts, change: undefined };
        }
        return withSettings((s) =>
          runDiff(s, opts, io, { createLLM: deps.createLLM, now: deps.now })
        );
      }
    );

  program
    .command("accept")
    .description("Accept a capture (or some of its pages) as the new baseline")
    .requiredOption("--from <tag>", "Capture to promote, e.g. current")
    .option("--to <tag>", "Tag to replace (default: baseline)")
    .option("--pages <list>", "Only these pages, comma-separated (e.g. /,/pricing or home,pricing)")
    .option("--force", "Accept even if some screenshots failed (they're left out)")
    .action((opts: { from: string; to?: string; pages?: string; force?: boolean }) =>
      withSettings((s) => runAccept(s, opts, io))
    );

  const baseline = program
    .command("baseline")
    .description("Review or restore earlier versions of the baseline");
  baseline
    .command("history")
    .description("List baseline versions, newest first")
    .option("--tag <tag>", "Baseline tag (default: baseline)")
    .action((opts: { tag?: string }) => withSettings((s) => runBaselineHistory(s, opts, io)));
  baseline
    .command("restore")
    .description("Make an archived version the baseline again")
    .argument("<version>", "Version number from 'baseline history'", parseVersion)
    .option("--tag <tag>", "Baseline tag (default: baseline)")
    .action((version: number, opts: { tag?: string }) =>
      withSettings((s) => runBaselineRestore(s, { ...opts, version }, io))
    );

  program
    .command("dashboard")
    .description("Start the web dashboard for browsing saved runs")
    .option("--port <number>", "Port to listen on (default DASHBOARD_PORT or 8100)", parsePort)
    .option("--host <address>", "Address to listen on (default DASHBOARD_HOST or 127.0.0.1)")
    .option(
      "--read-only",
      "Show runs and history but don't allow accepting or restoring baselines (or DASHBOARD_READ_ONLY=true)"
    )
    .action((opts: { port?: number; host?: string; readOnly?: boolean }) =>
      withSettings((s) => runDashboard(s, opts, io, { waitForStop: deps.waitForStop }))
    );

  return program;
}

/** True when this file is the script being run (not imported by tests). */
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Maps a parse error to an exit code: 0 for --help/--version, 2 for bad arguments. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof CommanderError) {
    return err.exitCode === 0 ? 0 : EXIT_ERROR;
  }
  return EXIT_ERROR;
}

if (isMain()) {
  createProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      // Commander has already printed its own message for argument errors.
      if (!(err instanceof CommanderError)) {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = exitCodeForError(err);
    });
}
