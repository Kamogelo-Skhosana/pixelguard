/**
 * Tests for accepting a capture as the new baseline — the library function,
 * the CLI command, and the dashboard API endpoint.
 *
 * Ticket: P044
 */

import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readManifest,
  writeManifest,
  type CaptureManifest,
  type ManifestPage,
} from "../src/capture/storage.js";
import { createProgram } from "../src/cli.js";
import { EXIT_ERROR, EXIT_OK, type CommandIO } from "../src/commands.js";
import { DEFAULT_VIEWPORTS, type Settings } from "../src/config.js";
import { createApp } from "../src/dashboard/app.js";
import { acceptAsBaseline, AcceptError } from "../src/dashboard/baselineManager.js";
import { getDatabase, saveRun } from "../src/report/persistence.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");
let out: string;

/** Writes a capture made of fixture images. pages: name -> viewport -> fixture folder (or "FAIL"). */
async function capture(
  tag: string,
  pages: Record<string, Record<string, string>>,
  capturedAt = "2026-09-25T08:00:00.000Z"
): Promise<void> {
  const dir = join(out, tag);
  const manifestPages: ManifestPage[] = [];
  for (const [name, shots] of Object.entries(pages)) {
    const screenshots: ManifestPage["screenshots"] = [];
    for (const [viewport, fixture] of Object.entries(shots)) {
      if (fixture === "FAIL") {
        screenshots.push({ viewport, ok: false, error: "HTTP 500" });
        continue;
      }
      await mkdir(join(dir, viewport), { recursive: true });
      await cp(join(fixtures, fixture, "current.png"), join(dir, viewport, `${name}.png`));
      screenshots.push({
        viewport,
        ok: true,
        file: `${viewport}/${name}.png`,
        width: 1,
        height: 1,
      });
    }
    manifestPages.push({
      page: name === "home" ? "/" : `/${name}`,
      name,
      url: `http://x/${name}`,
      screenshots,
    });
  }
  await mkdir(dir, { recursive: true });
  const manifest: CaptureManifest = {
    tag,
    capturedAt,
    baseUrl: "http://x",
    viewports: [],
    pages: manifestPages,
  };
  await writeManifest(dir, manifest);
}

/** Which fixture a baseline image came from, by comparing bytes. */
function fixtureOf(tag: string, file: string): string | undefined {
  const bytes = readFileSync(join(out, tag, file));
  const names = ["identical", "button-colour", "element-shift", "page-taller"];
  return names.find((n) => bytes.equals(readFileSync(join(fixtures, n, "current.png"))));
}

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "pixelguard-accept-"));
  await capture("baseline", {
    home: { desktop: "identical", mobile: "identical" },
    pricing: { desktop: "identical", mobile: "identical" },
    old: { desktop: "identical" },
  });
  await capture("current", {
    home: { desktop: "button-colour", mobile: "button-colour" },
    pricing: { desktop: "element-shift", mobile: "element-shift" },
  });
});

afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("acceptAsBaseline (P044)", () => {
  it("replaces the whole baseline with the current capture", async () => {
    const r = await acceptAsBaseline({
      outputDir: out,
      fromTag: "current",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });
    expect(r).toEqual({
      fromTag: "current",
      toTag: "baseline",
      pages: ["home", "pricing"],
      screenshots: 4,
      wholeCapture: true,
      version: 2,
    });
    const m = await readManifest(out, "baseline");
    expect(m.tag).toBe("baseline");
    expect(m.promotedFrom).toEqual({ tag: "current", at: "2026-09-25T10:00:00.000Z" });
    expect(m.pages.map((p) => p.name)).toEqual(["home", "pricing"]);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
    expect(fixtureOf("baseline", "mobile/pricing.png")).toBe("element-shift");
  });

  it("removes baseline pages that aren't in the accepted capture", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current" });
    expect(existsSync(join(out, "baseline", "desktop", "old.png"))).toBe(false);
  });

  it("leaves the source capture untouched and no temp folders behind", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current" });
    expect(fixtureOf("current", "desktop/home.png")).toBe("button-colour");
    expect((await readdir(out)).sort()).toEqual(["_history", "baseline", "current"]);
  });

  it("creates the baseline if there isn't one yet", async () => {
    await rm(join(out, "baseline"), { recursive: true });
    await acceptAsBaseline({ outputDir: out, fromTag: "current" });
    expect((await readManifest(out, "baseline")).pages).toHaveLength(2);
  });

  it("accepts just some pages, keeping the rest of the baseline", async () => {
    const r = await acceptAsBaseline({ outputDir: out, fromTag: "current", pages: ["/pricing"] });
    expect(r).toMatchObject({ pages: ["pricing"], screenshots: 2, wholeCapture: false });
    expect(fixtureOf("baseline", "desktop/pricing.png")).toBe("element-shift");
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical"); // untouched
    expect(existsSync(join(out, "baseline", "desktop", "old.png"))).toBe(true); // kept
    const m = await readManifest(out, "baseline");
    expect(m.pages.map((p) => p.name)).toEqual(["home", "pricing", "old"]);
    expect(m.promotedFrom?.pages).toEqual(["pricing"]);
  });

  it("accepts pages by path or name, and adds pages the baseline didn't have", async () => {
    await capture("current", {
      home: { desktop: "button-colour" },
      brandnew: { desktop: "page-taller" },
    });
    await acceptAsBaseline({ outputDir: out, fromTag: "current", pages: ["home", "/brandnew"] });
    const m = await readManifest(out, "baseline");
    expect(m.pages.map((p) => p.name)).toEqual(["home", "pricing", "old", "brandnew"]);
    // home now only has desktop; its old mobile file is removed
    expect(existsSync(join(out, "baseline", "mobile", "home.png"))).toBe(false);
    expect(fixtureOf("baseline", "desktop/brandnew.png")).toBe("page-taller");
  });

  it("refuses a capture with failed screenshots unless forced", async () => {
    await capture("current", { home: { desktop: "button-colour", mobile: "FAIL" } });
    await expect(acceptAsBaseline({ outputDir: out, fromTag: "current" })).rejects.toThrow(
      /1 screenshot\(s\) failed \(\/ \/ mobile\).*--force/
    );
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical"); // unchanged

    const r = await acceptAsBaseline({ outputDir: out, fromTag: "current", force: true });
    expect(r.screenshots).toBe(1);
    const m = await readManifest(out, "baseline");
    expect(m.pages[0].screenshots.map((s) => s.viewport)).toEqual(["desktop"]);
  });

  it.each([
    [{ fromTag: "current", toTag: "current" }, /as itself/],
    [{ fromTag: "nope" }, /No capture found for tag "nope"/],
    [{ fromTag: "current", pages: ["missing"] }, /Page\(s\) not in "current": missing/],
    [{ fromTag: "../evil" }, /Invalid tag/],
  ])("refuses %j without changing anything", async (opts, message) => {
    await expect(acceptAsBaseline({ outputDir: out, ...opts })).rejects.toThrow(message);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("refuses a page-by-page accept when there's no baseline yet", async () => {
    await rm(join(out, "baseline"), { recursive: true });
    await expect(
      acceptAsBaseline({ outputDir: out, fromTag: "current", pages: ["home"] })
    ).rejects.toThrow(AcceptError);
  });
});

describe("pixelguard accept (P044)", () => {
  async function run(args: string[]) {
    const lines: string[] = [];
    const errs: string[] = [];
    const io: CommandIO = { out: (l) => lines.push(l), err: (l) => errs.push(l), colour: false };
    const settings = {
      outputDir: out,
      viewports: DEFAULT_VIEWPORTS,
    } as unknown as Settings;
    let code: number | undefined;
    await createProgram({
      io,
      loadSettings: () => settings,
      setExitCode: (c) => {
        code = c;
      },
    }).parseAsync(["node", "pixelguard", ...args]);
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  }

  it("accepts the whole capture", async () => {
    const r = await run(["accept", "--from", "current"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toBe(
      'Accepted the whole "current" capture as the new "baseline" (4 screenshot(s)).'
    );
  });

  it("accepts selected pages", async () => {
    const r = await run(["accept", "--from", "current", "--pages", "home, /pricing"]);
    expect(r.out).toBe(
      'Accepted home, pricing from "current" as the new "baseline" (4 screenshot(s)).'
    );
  });

  it("explains a refusal and says nothing changed", async () => {
    const r = await run(["accept", "--from", "nope"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain('No capture found for tag "nope"');
    expect(r.err).toContain("The baseline was not changed.");
  });
});

describe("POST /api/runs/:id/accept (P044)", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = getDatabase(":memory:");
    const save = (createdAt: string) =>
      saveRun(db, {
        results: [],
        baselineTag: "baseline",
        currentTag: "current",
        createdAt: new Date(createdAt),
      });
    save("2026-09-25T07:00:00.000Z"); // run 1: before the current capture (08:00)
    save("2026-09-25T09:00:00.000Z"); // run 2: after it
    server = createApp({ db, outputDir: out }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it("accepts the run's current capture as its baseline", async () => {
    const r = await post("/api/runs/2/accept", {}, { origin: base });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toMatchObject({
      fromTag: "current",
      toTag: "baseline",
      screenshots: 4,
    });
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
  });

  it("accepts selected pages", async () => {
    const r = await post("/api/runs/2/accept", { pages: ["pricing"] });
    expect(r.body.accepted).toMatchObject({ pages: ["pricing"], wholeCapture: false });
  });

  it("refuses when the capture was re-taken after the run", async () => {
    const r = await post("/api/runs/1/accept", {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/re-captured since run 1/);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("refuses requests from another website", async () => {
    const r = await post("/api/runs/2/accept", {}, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const r2 = await post("/api/runs/2/accept", {}, { "sec-fetch-site": "cross-site" });
    expect(r2.status).toBe(403);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("requires a JSON body (plain HTML forms can't trigger it)", async () => {
    const res = await fetch(`${base}/api/runs/2/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "pages=home",
    });
    expect(res.status).toBe(415);
  });

  it.each([
    ["/api/runs/99/accept", {}, 404],
    ["/api/runs/abc/accept", {}, 400],
    ["/api/runs/2/accept", { pages: [] }, 400],
    ["/api/runs/2/accept", { pages: "home" }, 400],
    ["/api/runs/2/accept", { tag: "x" }, 400],
    ["/api/runs/2/accept", { pages: ["missing"] }, 409],
  ])("POST %s %j -> %i", async (path, body, status) => {
    expect((await post(path, body)).status).toBe(status);
  });

  it("flags failed screenshots with a code, and accepts the rest when forced (P043)", async () => {
    await capture(
      "current",
      { home: { desktop: "button-colour", mobile: "FAIL" } },
      "2026-09-25T08:00:00.000Z"
    );
    const refused = await post("/api/runs/2/accept", {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("failed_screenshots");
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");

    const forced = await post("/api/runs/2/accept", { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.accepted.screenshots).toBe(1);
    // Other refusals carry no code.
    expect((await post("/api/runs/2/accept", { pages: ["missing"] })).body.code).toBeUndefined();
  });

  it("returns 409 when the capture no longer exists", async () => {
    await rm(join(out, "current"), { recursive: true });
    const r = await post("/api/runs/2/accept", {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no longer exists/);
  });
});

describe("read-only dashboard (P047)", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = getDatabase(":memory:");
    saveRun(db, {
      results: [],
      baselineTag: "baseline",
      currentTag: "current",
      createdAt: new Date("2026-09-25T09:00:00.000Z"),
    });
    server = createApp({ db, outputDir: out, readOnly: true }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });

  it.each([
    ["/api/runs/1/accept", {}],
    ["/api/baselines/baseline/restore", { version: 1 }],
  ])("refuses POST %s and changes nothing", async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("read_only");
    expect(json.error).toMatch(/read-only.*pixelguard accept/);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("still serves reads and says it's read-only", async () => {
    expect((await fetch(`${base}/api/runs`)).status).toBe(200);
    expect((await fetch(`${base}/api/baselines/baseline/history`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ readOnly: true });
  });
});
