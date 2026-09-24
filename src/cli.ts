#!/usr/bin/env node
/**
 * CLI entry point for pixelguard.
 *
 * Usage:
 *   pixelguard capture --tag <name>
 *   pixelguard diff --baseline <tag> --current <tag>
 *
 * Ticket: P015
 */

import { Command } from "commander";

const program = new Command();

program.name("pixelguard").description("AI-powered visual regression testing agent");

program
  .command("capture")
  .description("Capture screenshots of all configured pages/viewports")
  .requiredOption("--tag <name>", "Tag to store this capture under (e.g. baseline, current)")
  .action((opts) => {
    // TODO (P006-P011): wire up capture layer
    console.log(
      `[pixelguard] Capturing screenshots under tag "${opts.tag}" ... (not yet implemented — see docs/TICKETS.md)`
    );
  });

program
  .command("diff")
  .description("Diff a baseline capture against a current capture")
  .requiredOption("--baseline <tag>", "Tag of the baseline capture")
  .requiredOption("--current <tag>", "Tag of the current capture")
  .option("--output <path>", "Write raw diff results as JSON")
  .option("--report <path>", "Write the AI-judged Markdown report (Phase 2)")
  .action((opts) => {
    // TODO (P012-P017): wire up diff engine (Phase 1)
    // TODO (P018-P034): wire up AI judgment + report generation (Phase 2)
    console.log(
      `[pixelguard] Diffing "${opts.baseline}" vs "${opts.current}" ... (not yet implemented — see docs/TICKETS.md)`
    );
  });

program.parse();
