/**
 * Tests for the dashboard API skeleton and server, using real HTTP requests.
 *
 * Ticket: P035
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgram, exitCodeForError } from "../src/cli.js";
import { EXIT_ERROR, EXIT_OK, type CommandIO } from "../src/commands.js";
import { ConfigError, DEFAULT_VIEWPORTS, loadSettings, type Settings } from "../src/config.js";
import { createApp, PIXELGUARD_VERSION } from "../src/dashboard/app.js";
import { startDashboard, type RunningDashboard } from "../src/dashboard/server.js";
import { getDatabase, SCHEMA_VERSION } from "../src/report/persistence.js";

let dir: string;
let dashboard: RunningDashboard;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-dash-"));
  dashboard = await startDashboard({
    databasePath: join(dir, "pixelguard.db"),
    host: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await dashboard?.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string, base = dashboard.url) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
};

describe("dashboard API skeleton (P035)", () => {
  it("GET /api/health reports status, version, schema and run count", async () => {
    const r = await get("/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: "ok",
      version: PIXELGUARD_VERSION,
      schemaVersion: SCHEMA_VERSION,
      runs: 0,
    });
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("doesn't advertise the server framework", async () => {
    expect((await get("/api/health")).headers.get("x-powered-by")).toBeNull();
  });

  it("answers unknown API routes with a JSON 404", async () => {
    const r = await get("/api/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "No API endpoint for GET /api/does-not-exist" });
  });

  it("turns route errors into a generic JSON 500 without internal details", async () => {
    const db = getDatabase(":memory:");
    const app = createApp({ db });
    db.close(); // make every query fail
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const { port } = server.address() as AddressInfo;
      const r = await get("/api/health", `http://127.0.0.1:${port}`);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: "Something went wrong on the server" });
      expect(errors).toHaveBeenCalled(); // logged on the server side
    } finally {
      errors.mockRestore();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("startDashboard", () => {
  it("explains a port that's already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(
        startDashboard({ databasePath: ":memory:", host: "127.0.0.1", port })
      ).rejects.toThrow(`Port ${port} is already in use`);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("close() stops the server", async () => {
    const d = await startDashboard({ databasePath: ":memory:", host: "127.0.0.1", port: 0 });
    await d.close();
    await expect(fetch(`${d.url}/api/health`)).rejects.toThrow();
  });
});

describe("pixelguard dashboard command", () => {
  const settings: Settings = {
    targetBaseUrl: "http://example.test",
    targetPages: ["/"],
    viewports: DEFAULT_VIEWPORTS,
    outputDir: "screenshots",
    diffDir: "diffs",
    regionsFile: "none.json",
    regionsFileRequired: false,
    llmApiKey: "",
    llmModel: "m",
    databaseUrl: "sqlite::memory:",
    databasePath: ":memory:",
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
  };

  async function run(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CommandIO = { out: (l) => out.push(l), err: (l) => err.push(l), colour: false };
    let code: number | undefined;
    let healthWhileRunning: unknown;
    await createProgram({
      io,
      loadSettings: () => settings,
      setExitCode: (c) => {
        code = c;
      },
      // Check it's really serving, then stop instead of waiting for Ctrl+C.
      waitForStop: async (d) => {
        healthWhileRunning = (await get("/api/health", d.url)).body;
        await d.close();
      },
    }).parseAsync(["node", "pixelguard", ...args]);
    return { code, out: out.join("\n"), err: err.join("\n"), healthWhileRunning };
  }

  it("starts the server, prints its URL, and exits cleanly when stopped", async () => {
    const r = await run(["dashboard"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toMatch(/pixelguard dashboard running at http:\/\/127\.0\.0\.1:\d+/);
    expect(r.out).toContain("Press Ctrl+C to stop.");
    expect(r.healthWhileRunning).toMatchObject({ status: "ok" });
  });

  it("--port and --host override the settings", async () => {
    const r = await run(["dashboard", "--port", "0", "--host", "127.0.0.1"]);
    expect(r.code).toBe(EXIT_OK);
  });

  it("exits 2 with a clear message when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", res));
    const { port } = blocker.address() as AddressInfo;
    try {
      const r = await run(["dashboard", "--port", String(port)]);
      expect(r.code).toBe(EXIT_ERROR);
      expect(r.err).toContain(`Port ${port} is already in use`);
    } finally {
      await new Promise((res) => blocker.close(res));
    }
  });

  it.each(["abc", "70000", "-1", "8.5"])("rejects --port %s", async (port) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await run(["dashboard", "--port", port]).catch((e) => e);
    stderr.mockRestore();
    expect(err).toBeInstanceOf(CommanderError);
    expect(exitCodeForError(err)).toBe(EXIT_ERROR);
  });
});

describe("dashboard settings", () => {
  it("defaults to 127.0.0.1:8100", () => {
    const s = loadSettings({ TARGET_BASE_URL: "http://x.test" });
    expect([s.dashboardHost, s.dashboardPort]).toEqual(["127.0.0.1", 8100]);
  });

  it("reads DASHBOARD_HOST and DASHBOARD_PORT", () => {
    const s = loadSettings({
      TARGET_BASE_URL: "http://x.test",
      DASHBOARD_HOST: "0.0.0.0",
      DASHBOARD_PORT: "9000",
    });
    expect([s.dashboardHost, s.dashboardPort]).toEqual(["0.0.0.0", 9000]);
  });

  it.each(["abc", "70000", "80.5"])("rejects DASHBOARD_PORT=%s", (port) => {
    expect(() => loadSettings({ TARGET_BASE_URL: "http://x.test", DASHBOARD_PORT: port })).toThrow(
      ConfigError
    );
  });
});
