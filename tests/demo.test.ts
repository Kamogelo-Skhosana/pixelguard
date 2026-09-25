/**
 * Tests for the presenter's demo: its options, the scripted demo judge, the
 * demo site's ?version switch, and `npm run demo` itself run as a real
 * process with the scripted judge.
 *
 * Ticket: P049
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedDemoJudge, SCRIPTED_JUDGE_MODEL } from "../examples/demo-site/scriptedJudge.js";
import { startDemoSite, type DemoSite } from "../examples/demo-site/site.js";
import { parseDemoArgs } from "../scripts/demoOptions.js";
import { parseJudgeResponse } from "../src/judge/judge.js";
import type { JudgePrompt } from "../src/judge/prompts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("demo options (P049)", () => {
  it("defaults to a plain run", () => {
    expect(parseDemoArgs([])).toEqual({
      step: false,
      dashboard: false,
      scriptedJudge: false,
      port: 8100,
      help: false,
    });
  });

  it("reads every option", () => {
    expect(
      parseDemoArgs(["--step", "--dashboard", "--scripted-judge", "--port", "9000", "--help"])
    ).toEqual({ step: true, dashboard: true, scriptedJudge: true, port: 9000, help: true });
    expect(parseDemoArgs(["-h"]).help).toBe(true);
  });

  it.each([
    [["--port"], /--port needs a number/],
    [["--port", "abc"], /--port needs a number/],
    [["--port", "70000"], /--port needs a number/],
    [["--judge"], /Unknown option "--judge"/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseDemoArgs(argv)).toThrow(message);
  });
});

describe("scripted demo judge (P049)", () => {
  const prompt = (page: string, viewport: string) =>
    ({ system: "", user: `Check: ${page} page at ${viewport} viewport\n...` }) as JudgePrompt;
  const images = { baseline: "", current: "", diff: "" };

  it("calls the date change acceptable and the pricing layout a bug", async () => {
    const judge = new ScriptedDemoJudge();
    const home = parseJudgeResponse((await judge.judge(images, prompt("home", "mobile"))).text);
    const pricing = parseJudgeResponse(
      (await judge.judge(images, prompt("pricing", "desktop"))).text
    );
    expect(home).toMatchObject({ verdict: "Acceptable Change", confidence: 9 });
    expect(pricing).toMatchObject({ verdict: "Real Bug", confidence: 9 });
    expect(judge.calls).toEqual(["home / mobile", "pricing / desktop"]);
  });

  it("says it only knows the demo pages, and is always labelled as scripted", async () => {
    const judge = new ScriptedDemoJudge();
    const reply = await judge.judge(images, prompt("checkout", "desktop"));
    expect(parseJudgeResponse(reply.text)).toMatchObject({ verdict: "Uncertain" });
    expect(reply.model).toBe(SCRIPTED_JUDGE_MODEL);
    expect(judge.model).toBe("scripted-demo-judge");
    expect(reply.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("demo site ?version (P049)", () => {
  let site: DemoSite;
  beforeAll(async () => {
    site = await startDemoSite({ version: 1 });
  });
  afterAll(async () => {
    await site.close();
  });
  const get = async (path: string) => (await fetch(`${site.url}${path}`)).text();
  const broken = "margin-right: -240px";

  it("shows either version for one page view without switching the site", async () => {
    expect(await get("/pricing")).not.toContain(broken);
    expect(await get("/pricing?version=2")).toContain(broken);
    expect(await get("/pricing")).not.toContain(broken);
    site.setVersion(2);
    expect(await get("/pricing?version=1")).not.toContain(broken);
    expect(await get("/pricing")).toContain(broken);
    expect(await get("/pricing?version=9")).toContain(broken); // unknown: current version
    site.setVersion(1);
  });
});

describe("npm run demo (P049)", () => {
  let out: string;
  let result: { code: number | null; stdout: string; stderr: string };

  /** Runs scripts/demo.ts like `npm run demo -- <args>`, from a temporary folder. */
  function demo(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
    return new Promise<typeof result>((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/demo.ts"), ...args],
        {
          cwd,
          // No .env in cwd, and no API key: the demo can't reach a real model.
          env: { ...process.env, LLM_API_KEY: "", NO_COLOR: "1", ...env },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "pixelguard-demo-"));
    result = await demo(["--scripted-judge", "--step"], out, {
      PIXELGUARD_DEMO_OUT: join(out, "demo-output"),
    });
  }, 120_000);

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("runs the whole flow and finds the bug with the scripted judge", () => {
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('Using the scripted demo judge ("scripted-demo-judge")');
    // No terminal, so --step doesn't wait for Enter.
    expect(result.stdout).toContain("--step needs an interactive terminal");
    expect(result.stdout).toContain("Judging 4 changed screenshot(s) with scripted-demo-judge");
    expect(result.stdout).toMatch(/✗ pricing\s+FAIL\s+Real Bug/);
    expect(result.stdout).toMatch(/✓ home\s+PASS\s+Acceptable changes/);
    expect(result.stdout).toContain("✗ FAIL: 2 real bugs on 1 page, 2 acceptable changes");
  });

  it("writes the report, JSON and database where asked", () => {
    const dir = join(out, "demo-output");
    const report = readFileSync(join(dir, "report.md"), "utf8");
    expect(report).toContain("scripted-demo-judge");
    expect(existsSync(join(dir, "diffs.json"))).toBe(true);
    const db = new Database(join(dir, "pixelguard.db"), { readonly: true });
    const run = db.prepare("SELECT status, judge_model FROM runs").get() as {
      status: string;
      judge_model: string;
    };
    db.close();
    expect(run).toEqual({ status: "fail", judge_model: "scripted-demo-judge" });
  });

  it("explains its options, and rejects unknown ones", async () => {
    const help = await demo(["--help"], out);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--scripted-judge");
    const bad = await demo(["--nope"], out);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('Unknown option "--nope"');
  });
});
