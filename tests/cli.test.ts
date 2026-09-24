/**
 * End-to-end tests for the CLI: capture a baseline, change the site,
 * capture again, and diff — against a local HTTP server.
 *
 * Ticket: P015
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgram, exitCodeForError } from "../src/cli.js";
import { EXIT_CHANGES, EXIT_ERROR, EXIT_OK, type CommandIO } from "../src/commands.js";
import { ConfigError, DEFAULT_VIEWPORTS, type Settings } from "../src/config.js";
import { readJsonReport } from "../src/report/jsonExport.js";

let server: Server;
let root: string;
let settings: Settings;
let heading = "Welcome";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/about") {
      const title = req.url === "/" ? heading : "About us";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!doctype html><body style="font-family:Arial;padding:20px"><h1>${title}</h1></body>`
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  root = await mkdtemp(join(tmpdir(), "pixelguard-cli-"));
  settings = {
    targetBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    targetPages: ["/", "/about"],
    viewports: DEFAULT_VIEWPORTS.filter((v) => v.name !== "tablet"),
    outputDir: join(root, "screenshots"),
    diffDir: join(root, "diffs"),
    regionsFile: join(root, "no-regions.json"),
    regionsFileRequired: false,
    llmApiKey: "",
    llmModel: "test",
    databaseUrl: "sqlite::memory:",
    databasePath: ":memory:",
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Runs the CLI with captured output and returns { code, out, err }. */
async function run(args: string[], overrides: Partial<Settings> | Error = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = { out: (l) => out.push(l), err: (l) => err.push(l), colour: false };
  let code: number | undefined;
  const program = createProgram({
    io,
    loadSettings: () => {
      if (overrides instanceof Error) throw overrides;
      return { ...settings, ...overrides };
    },
    setExitCode: (c) => {
      code = c;
    },
  });
  await program.parseAsync(["node", "pixelguard", ...args]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("pixelguard CLI (P015)", () => {
  it("capture saves a baseline and reports progress", async () => {
    const r = await run(["capture", "--tag", "baseline"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("Capturing 2 page(s) x 2 viewport(s)");
    expect(r.out).toContain("✓ /  desktop, mobile");
    expect(r.out).toContain("✓ /about  desktop, mobile");
    expect(r.out).toContain(`Saved 4 screenshot(s) to ${join(settings.outputDir, "baseline")}`);
  });

  it("capture of an unchanged site then diff shows no changes", async () => {
    await run(["capture", "--tag", "same"]);
    const r = await run([
      "diff",
      "--baseline",
      "baseline",
      "--current",
      "same",
      "--fail-on-change",
    ]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("0 of 4 screenshots changed.");
  });

  it("diff finds a changed heading, writes JSON, and --fail-on-change exits 1", async () => {
    heading = "Welcome back";
    expect((await run(["capture", "--tag", "current"])).code).toBe(EXIT_OK);

    const json = join(root, "out", "diffs.json");
    const r = await run([
      "diff",
      "--baseline",
      "baseline",
      "--current",
      "current",
      "--output",
      json,
      "--fail-on-change",
    ]);

    expect(r.code).toBe(EXIT_CHANGES);
    expect(r.out).toMatch(/home\s+desktop\s+[\d.]+%\s+[\d,]+\s+CHANGED/);
    expect(r.out).toMatch(/about\s+desktop\s+0%\s+0\s+unchanged/);
    expect(r.out).toContain("2 of 4 screenshots changed.");
    expect(r.out).toContain(`JSON results: ${json}`);
    expect(r.err).toContain("Failing because 2 screenshot(s) changed");

    const report = await readJsonReport(json);
    expect(report).toMatchObject({
      baselineTag: "baseline",
      currentTag: "current",
      targetUrl: settings.targetBaseUrl,
      summary: { total: 4, changed: 2 },
    });
  });

  it("diff without --fail-on-change exits 0 even when things changed", async () => {
    const r = await run(["diff", "--baseline", "baseline", "--current", "current"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("2 of 4 screenshots changed.");
  });

  it("--threshold 1 ignores the colour differences", async () => {
    const r = await run([
      "diff",
      "--baseline",
      "baseline",
      "--current",
      "current",
      "--threshold",
      "1",
    ]);
    expect(r.out).toContain("0 of 4 screenshots changed.");
  });

  it("capture exits 2 and lists failures when a page is broken", async () => {
    const r = await run(["capture", "--tag", "broken"], { targetPages: ["/", "/missing"] });
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.out).toContain("✗ /missing");
    expect(r.err).toContain("desktop: Failed to load");
    expect(r.err).toContain("HTTP 404");
    expect(r.err).toContain("2 screenshot(s) failed");
  });

  it("diff shows skipped screenshots", async () => {
    const r = await run(["diff", "--baseline", "baseline", "--current", "broken"]);
    expect(r.err).toContain("Skipped 4 screenshot(s)");
    expect(r.err).toMatch(/about \/ desktop: not in "broken"/);
    expect(r.err).toMatch(/missing \/ desktop: not in "baseline"/);
  });

  it("diff exits 2 with a helpful message for a missing tag", async () => {
    const r = await run(["diff", "--baseline", "baseline", "--current", "nope"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("Run: pixelguard capture --tag nope");
  });

  it("warns that --report isn't available until Phase 2", async () => {
    const r = await run([
      "diff",
      "--baseline",
      "baseline",
      "--current",
      "same",
      "--report",
      "r.md",
    ]);
    expect(r.err).toContain("--report");
    expect(r.err).toContain("Phase 2");
  });

  it("prints config errors without a stack trace and exits 2", async () => {
    const r = await run(
      ["capture", "--tag", "x"],
      new ConfigError(["TARGET_BASE_URL is required"])
    );
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("Invalid pixelguard configuration");
    expect(r.err).not.toContain("    at ");
  });

  it("rejects an invalid --threshold with exit code 2", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await run(["diff", "--baseline", "a", "--current", "b", "--threshold", "5"]).catch(
      (e) => e
    );
    stderr.mockRestore();
    expect(err).toBeInstanceOf(CommanderError);
    expect(exitCodeForError(err)).toBe(EXIT_ERROR);
  });

  it("ignores a known dynamic region from the regions file end to end (P019)", async () => {
    const regionsFile = join(root, "pixelguard.regions.json");
    await writeFile(
      regionsFile,
      JSON.stringify({
        regions: [
          { page: "/", label: "Greeting", kind: "other", selector: "h1", handling: "ignore" },
        ],
      })
    );
    const withRegions = { regionsFile, regionsFileRequired: true };

    heading = "Hello";
    const base = await run(["capture", "--tag", "r1"], withRegions);
    expect(base.out).toContain("Using 1 known dynamic region(s)");
    heading = "Hello again, and welcome";
    await run(["capture", "--tag", "r2"], withRegions);

    const r = await run(
      ["diff", "--baseline", "r1", "--current", "r2", "--fail-on-change"],
      withRegions
    );
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("0 of 4 screenshots changed.");
    expect(r.out).toMatch(/home\s+desktop\s+0%\s+0\s+unchanged\s+ignored: Greeting/);
  });

  it("exits 2 when a required regions file is missing or invalid", async () => {
    const missing = await run(["capture", "--tag", "x"], {
      regionsFile: join(root, "nope.json"),
      regionsFileRequired: true,
    });
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err).toContain("could not read the file");

    const badFile = join(root, "bad-regions.json");
    await writeFile(badFile, JSON.stringify({ regions: [{ page: "/" }] }));
    const bad = await run(["diff", "--baseline", "a", "--current", "b"], { regionsFile: badFile });
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.err).toContain("regions[0].label");
  });

  describe("change description (P020)", () => {
    const diffArgs = ["diff", "--baseline", "baseline", "--current", "same"];

    it("--change is shown and saved in the JSON report", async () => {
      const json = join(root, "change.json");
      const r = await run([
        ...diffArgs,
        "--change",
        "  Redesigned the checkout button ",
        "--output",
        json,
      ]);
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain("What changed: Redesigned the checkout button");
      expect((await readJsonReport(json)).changeDescription).toBe("Redesigned the checkout button");
    });

    it("--change-file reads a longer description", async () => {
      const notes = join(root, "notes.txt");
      await writeFile(notes, "New hero section\n- bigger heading\n- new colours\n");
      const json = join(root, "change-file.json");
      const r = await run([...diffArgs, "--change-file", notes, "--output", json]);
      expect(r.out).toContain("What changed: New hero section (+2 more line(s))");
      expect((await readJsonReport(json)).changeDescription).toBe(
        "New hero section\n- bigger heading\n- new colours"
      );
    });

    it("leaves changeDescription out of the JSON when none is given", async () => {
      const json = join(root, "no-change.json");
      await run([...diffArgs, "--output", json]);
      expect((await readJsonReport(json)).changeDescription).toBeUndefined();
    });

    it("reads PIXELGUARD_CHANGE from the environment", async () => {
      process.env.PIXELGUARD_CHANGE = "From CI: bump footer links";
      try {
        const r = await run(diffArgs);
        expect(r.out).toContain("What changed: From CI: bump footer links");
      } finally {
        delete process.env.PIXELGUARD_CHANGE;
      }
    });

    it("an explicit --change-file wins over PIXELGUARD_CHANGE", async () => {
      const notes = join(root, "notes2.txt");
      await writeFile(notes, "From the file");
      process.env.PIXELGUARD_CHANGE = "From the environment";
      try {
        const r = await run([...diffArgs, "--change-file", notes]);
        expect(r.code).toBe(EXIT_OK);
        expect(r.out).toContain("What changed: From the file");
      } finally {
        delete process.env.PIXELGUARD_CHANGE;
      }
    });

    it("rejects --change together with --change-file", async () => {
      const r = await run([...diffArgs, "--change", "a", "--change-file", join(root, "notes.txt")]);
      expect(r.code).toBe(EXIT_ERROR);
      expect(r.err).toContain("either --change or --change-file");
    });

    it("exits 2 for a missing file or an over-long description", async () => {
      const missing = await run([...diffArgs, "--change-file", join(root, "nope.txt")]);
      expect(missing.code).toBe(EXIT_ERROR);
      expect(missing.err).toContain("Could not read --change-file");

      const long = await run([...diffArgs, "--change", "x".repeat(1001)]);
      expect(long.code).toBe(EXIT_ERROR);
      expect(long.err).toContain("keep it under 1000");
    });
  });

  it("treats --help as success", () => {
    expect(exitCodeForError(new CommanderError(0, "commander.helpDisplayed", ""))).toBe(0);
  });
});
