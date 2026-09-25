/**
 * Tests for baseline versioning and history: archiving on accept,
 * restoring, pruning, the CLI commands and the dashboard API.
 *
 * Ticket: P045
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listTags,
  writeManifest,
  type CaptureManifest,
  type ManifestPage,
} from "../src/capture/storage.js";
import { createProgram, exitCodeForError } from "../src/cli.js";
import { EXIT_ERROR, EXIT_OK, type CommandIO } from "../src/commands.js";
import type { Settings } from "../src/config.js";
import { createApp } from "../src/dashboard/app.js";
import {
  getBaselineHistory,
  readVersionManifest,
  versionDir,
} from "../src/dashboard/baselineHistory.js";
import { acceptAsBaseline, restoreBaseline } from "../src/dashboard/baselineManager.js";
import { getDatabase } from "../src/report/persistence.js";

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

const t = (hour: number) => new Date(`2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`);

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "pixelguard-history-"));
  await capture(
    "baseline",
    { home: { desktop: "identical" }, pricing: { desktop: "identical" } },
    "2026-09-20T08:00:00.000Z"
  );
  await capture("current", {
    home: { desktop: "button-colour" },
    pricing: { desktop: "element-shift" },
  });
});

afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("baseline history (P045)", () => {
  it("has no history before the first accept", async () => {
    expect(await getBaselineHistory(out)).toEqual({
      tag: "baseline",
      currentVersion: null,
      versions: [],
    });
  });

  it("archives the original baseline as version 1 on the first accept", async () => {
    const r = await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    expect(r.version).toBe(2);

    const h = await getBaselineHistory(out);
    expect(h.currentVersion).toBe(2);
    expect(h.versions).toEqual([
      {
        version: 2,
        createdAt: "2026-09-25T10:00:00.000Z",
        source: { type: "accept", fromTag: "current", pages: null, screenshots: 2 },
        current: true,
        archived: false,
      },
      {
        version: 1,
        createdAt: "2026-09-20T08:00:00.000Z",
        source: { type: "accept", fromTag: "baseline", pages: null, screenshots: 0 },
        current: false,
        archived: true,
      },
    ]);
    // The archived files are the old baseline's.
    const v1 = versionDir(out, "baseline", 1);
    expect(
      readFileSync(join(v1, "desktop", "home.png")).equals(
        readFileSync(join(fixtures, "identical", "current.png"))
      )
    ).toBe(true);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
  });

  it("records each accept as a new version, including page accepts", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    await capture("current", { pricing: { desktop: "page-taller" } }, "2026-09-25T11:00:00.000Z");
    await acceptAsBaseline({ outputDir: out, fromTag: "current", pages: ["pricing"], now: t(12) });

    const h = await getBaselineHistory(out);
    expect(h.versions.map((v) => [v.version, v.current, v.archived])).toEqual([
      [3, true, false],
      [2, false, true],
      [1, false, true],
    ]);
    expect(h.versions[0].source).toEqual({
      type: "accept",
      fromTag: "current",
      pages: ["pricing"],
      screenshots: 1,
    });
  });

  it("restores an archived version and records the restore as a new version", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    const r = await restoreBaseline({ outputDir: out, version: 1, now: t(11) });
    expect(r).toEqual({ version: 3 });

    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical"); // back to v1
    const h = await getBaselineHistory(out);
    expect(h.versions[0]).toMatchObject({
      version: 3,
      current: true,
      source: { type: "restore", fromVersion: 1 },
    });
    expect(h.versions.find((v) => v.version === 2)?.archived).toBe(true); // the replaced one is archived
  });

  it("a restore can itself be undone", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    await restoreBaseline({ outputDir: out, version: 1, now: t(11) });
    await restoreBaseline({ outputDir: out, version: 2, now: t(12) });
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
    expect((await getBaselineHistory(out)).currentVersion).toBe(4);
  });

  it.each([
    [1, /already the current/],
    [9, /no version 9/],
  ])("refuses to restore version %i", async (version, message) => {
    // Before any accept there's no history at all, so accept once and restore v1 to make it current.
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    await restoreBaseline({ outputDir: out, version: 1, now: t(11) }); // current is now v3 (= v1 content)
    const current = (await getBaselineHistory(out)).currentVersion!;
    const target = version === 1 ? current : version;
    await expect(restoreBaseline({ outputDir: out, version: target })).rejects.toThrow(message);
  });

  it("keeps only the newest archives, but the whole history list", async () => {
    for (let i = 0; i < 4; i++) {
      await capture(
        "current",
        { home: { desktop: i % 2 ? "identical" : "button-colour" } },
        `2026-09-25T0${i}:30:00.000Z`
      );
      await acceptAsBaseline({
        outputDir: out,
        fromTag: "current",
        now: t(10 + i),
        keepVersions: 2,
      });
    }
    const h = await getBaselineHistory(out);
    expect(h.versions.map((v) => [v.version, v.archived])).toEqual([
      [5, false], // current
      [4, true],
      [3, true],
      [2, false], // pruned
      [1, false], // pruned
    ]);
    await expect(restoreBaseline({ outputDir: out, version: 1 })).rejects.toThrow(
      /no longer archived/
    );
  });

  it("history folders never show up as captures", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current" });
    expect(await listTags(out)).toEqual(["baseline", "current"]);
  });

  it("reads the manifest of the current and archived versions", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    expect((await readVersionManifest(out, "baseline", 1))?.capturedAt).toBe(
      "2026-09-20T08:00:00.000Z"
    );
    expect((await readVersionManifest(out, "baseline", 2))?.promotedFrom?.tag).toBe("current");
    expect(await readVersionManifest(out, "baseline", 7)).toBeNull();
  });
});

describe("pixelguard baseline history / restore (P045)", () => {
  async function run(args: string[]) {
    const lines: string[] = [];
    const errs: string[] = [];
    const io: CommandIO = { out: (l) => lines.push(l), err: (l) => errs.push(l), colour: false };
    let code: number | undefined;
    await createProgram({
      io,
      loadSettings: () => ({ outputDir: out }) as unknown as Settings,
      setExitCode: (c) => {
        code = c;
      },
    }).parseAsync(["node", "pixelguard", ...args]);
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  }

  it("says when there's no history yet", async () => {
    const r = await run(["baseline", "history"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("has no history yet");
  });

  it("lists versions newest first", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    const r = await run(["baseline", "history"]);
    expect(r.out.split("\n")).toEqual([
      'History of "baseline" (newest first):',
      '  v2  2026-09-25T10:00:00.000Z  accepted from "current"  [current]',
      "  v1  2026-09-20T08:00:00.000Z  original baseline  [archived]",
    ]);
  });

  it("restores a version (accepting 'v1' or '1')", async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    const r = await run(["baseline", "restore", "v1"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('Restored version 1 of "baseline" (recorded as version 3');
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("explains a failed restore and says nothing changed", async () => {
    const r = await run(["baseline", "restore", "5"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("There's no version 5");
    expect(r.err).toContain("The baseline was not changed.");
  });

  it("rejects a version that isn't a number", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = await run(["baseline", "restore", "latest"]).catch((e) => e);
    stderr.mockRestore();
    expect(exitCodeForError(err)).toBe(EXIT_ERROR);
  });
});

describe("baseline history API (P045)", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    await acceptAsBaseline({ outputDir: out, fromTag: "current", now: t(10) });
    db = getDatabase(":memory:");
    server = createApp({ db, outputDir: out }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, type: res.headers.get("content-type"), res };
  };

  it("GET /api/baselines/baseline/history lists the versions", async () => {
    const { status, res } = await get("/api/baselines/baseline/history");
    expect(status).toBe(200);
    const body = await res.json();
    expect(body.currentVersion).toBe(2);
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("GET /api/baselines/baseline/versions/1 lists that version's pages with image URLs", async () => {
    const body = await (await get("/api/baselines/baseline/versions/1")).res.json();
    expect(body).toMatchObject({
      tag: "baseline",
      version: 1,
      capturedAt: "2026-09-20T08:00:00.000Z",
    });
    expect(body.pages[0]).toEqual({
      page: "/",
      name: "home",
      screenshots: [
        { viewport: "desktop", image: "/api/baselines/baseline/versions/1/images/desktop/home" },
      ],
    });
  });

  it.each([
    [1, "identical"],
    [2, "button-colour"],
  ])("serves version %i's images", async (version, fixture) => {
    const { status, type, res } = await get(
      `/api/baselines/baseline/versions/${version}/images/desktop/home`
    );
    expect(status).toBe(200);
    expect(type).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(readFileSync(join(fixtures, fixture, "current.png")))).toBe(true);
  });

  it.each([
    "/api/baselines/baseline/versions/9",
    "/api/baselines/baseline/versions/1/images/desktop/missing",
    "/api/baselines/baseline/versions/1/images/..%2F..%2Fcurrent/home",
  ])("returns 404 for %s", async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  it.each(["/api/baselines/..%2Fx/history", "/api/baselines/baseline/versions/0"])(
    "returns 400 for %s",
    async (path) => {
      expect((await get(path)).status).toBe(400);
    }
  );

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("POST /api/baselines/baseline/restore restores a version", async () => {
    const res = await post("/api/baselines/baseline/restore", { version: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: { tag: "baseline", fromVersion: 1, version: 3 } });
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("restore has the same protections as accept", async () => {
    expect(
      (
        await post(
          "/api/baselines/baseline/restore",
          { version: 1 },
          { origin: "https://evil.example" }
        )
      ).status
    ).toBe(403);
    expect((await post("/api/baselines/baseline/restore", { version: 2 })).status).toBe(409); // already current
    expect((await post("/api/baselines/baseline/restore", { version: "1" })).status).toBe(400);
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
  });
});
