/**
 * Command-line options for `npm run demo` (scripts/demo.ts), kept separate
 * so they can be tested without running the demo.
 *
 * Ticket: P049
 */

export interface DemoOptions {
  /** Pause before each step (for presenting live). */
  step: boolean;
  /** Start the dashboard on the demo's results afterwards. */
  dashboard: boolean;
  /** Use the scripted demo judge instead of the real AI (no API calls). */
  scriptedJudge: boolean;
  /** Dashboard port. */
  port: number;
  help: boolean;
}

export const DEMO_HELP = `Usage: npm run demo -- [options]

Runs pixelguard end to end against the bundled demo shop: capture version 1,
switch to version 2 (a harmless date change and a real layout bug), capture
again, diff, judge, and write demo-output/report.md.

Options:
  --step            Pause before each step (press Enter) - for presenting live
  --dashboard       Open the dashboard on the results when done (Ctrl+C to stop)
  --port <number>   Dashboard port (default 8100)
  --scripted-judge  Use the scripted demo judge instead of the AI - no internet or
                    API key needed; its verdicts are labelled "scripted-demo-judge"
  -h, --help        Show this help

The AI judge runs when LLM_API_KEY is set in .env (unless --scripted-judge).
See docs/DEMO.md for a presenter's walkthrough.`;

export class DemoOptionsError extends Error {}

export function parseDemoArgs(argv: string[]): DemoOptions {
  const options: DemoOptions = {
    step: false,
    dashboard: false,
    scriptedJudge: false,
    port: 8100,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--step":
        options.step = true;
        break;
      case "--dashboard":
        options.dashboard = true;
        break;
      case "--scripted-judge":
        options.scriptedJudge = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--port": {
        const value = argv[++i];
        const port = Number(value);
        if (value === undefined || !/^\d+$/.test(value) || port < 1 || port > 65535) {
          throw new DemoOptionsError("--port needs a number from 1 to 65535.");
        }
        options.port = port;
        break;
      }
      default:
        throw new DemoOptionsError(`Unknown option "${arg}". Try --help.`);
    }
  }
  return options;
}
