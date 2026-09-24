#!/usr/bin/env node
/**
 * CLI entry point for pixelguard.
 *
 * Usage:
 *   pixelguard capture --tag <name>
 *   pixelguard diff --baseline <tag> --current <tag> [--output diffs.json]
 *                   [--threshold 0.1] [--fail-on-change]
 *                   [--change "<what changed>" | --change-file notes.txt] [--judge]
 *                   [--fail-on-bug]
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
  runDiff,
  type CommandIO,
  type DiffCommandDeps,
} from "./commands.js";
import { ConfigError, loadSettings, type Settings } from "./config.js";
import { shouldUseColour } from "./report/console.js";

export interface ProgramDeps extends DiffCommandDeps {
  io?: CommandIO;
  loadSettings?: () => Settings;
  /** Receives the command's exit code (defaults to setting process.exitCode). */
  setExitCode?: (code: number) => void;
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
    .version("0.1.0")
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
    .option("--report <path>", "Write the AI-judged Markdown report (Phase 2)")
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
        },
        cmd: Command
      ) => {
        // An explicit --change-file wins over a PIXELGUARD_CHANGE set in the environment.
        if (opts.changeFile !== undefined && cmd.getOptionValueSource("change") === "env") {
          opts = { ...opts, change: undefined };
        }
        return withSettings((s) => runDiff(s, opts, io, { createLLM: deps.createLLM }));
      }
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
