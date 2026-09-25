/**
 * Browser tests for the dashboard's actions: accepting a run as the new
 * baseline, the baseline history page and restoring an old version, plus the
 * router's cancellation and "Try again". Real Chromium, real app, real
 * capture folders on disk.
 *
 * Ticket: P043
 */

import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, launchBrowser } from "../src/capture/browser.js";
import { writeManifest, type CaptureManifest, type ManifestPage } from "../src/capture/storage.js";
import { createApp } from "../src/dashboard/app.js";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { getDatabase, saveRun } from "../src/report/persistence.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "diff");

let browser: Browser;
let page: Page;
let pageErrors: string[];
let out: string;
let db: Database.Database;
let server: Server;
let url: string;

/** Writes a capture of fixture images. pages: name -> viewport -> fixture folder (or "FAIL"). */
async function capture(tag: string, pages: Record<string, Record<string, string>>) {
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
    manifestPages.push({ page: `/${name}`, name, url: `http://x/${name}`, screenshots });
  }
  await mkdir(dir, { recursive: true });
  const manifest: CaptureManifest = {
    tag,
    capturedAt: "2026-09-25T08:00:00.000Z",
    baseUrl: "http://x",
    viewports: [],
    pages: manifestPages,
  };
  await writeManifest(dir, manifest);
}

/** Which fixture a screenshot in a capture came from, by comparing bytes. */
function fixtureOf(tag: string, file: string): string | undefined {
  const bytes = readFileSync(join(out, tag, file));
  return ["identical", "button-colour", "element-shift"].find((n) =>
    bytes.equals(readFileSync(join(fixtures, n, "current.png")))
  );
}

function shot(name: string, verdict?: Verdict): DiffResult {
  return {
    page: name,
    viewport: "desktop",
    pixelDiffCount: verdict ? 5 : 0,
    totalPixels: 100,
    percentChanged: verdict ? 5 : 0,
    changed: Boolean(verdict),
    sizeChanged: false,
    baselineSize: { width: 1, height: 1 },
    currentSize: { width: 1, height: 1 },
    diffImagePath: "d.png",
    baselineImagePath: "b.png",
    currentImagePath: "c.png",
    ...(verdict && { verdict, confidence: 9, explanation: "x", judgedBy: "claude-sonnet-5" }),
  };
}

function saveTestRun(results: DiffResult[], createdAt = "2026-09-25T09:00:00.000Z"): number {
  return saveRun(db, {
    results,
    baselineTag: "baseline",
    currentTag: "current",
    createdAt: new Date(createdAt),
  });
}

async function open(path: string) {
  await page.goto(`${url}/${path}`, { waitUntil: "domcontentloaded", timeout: 12_000 });
  await page.waitForFunction(() => Number(document.body.dataset.renders ?? "0") >= 1, undefined, {
    timeout: 12_000,
  });
}

const renders = () => page.evaluate(() => Number(document.body.dataset.renders ?? "0"));

async function navigate(hash: string) {
  const before = await renders();
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForFunction((b) => Number(document.body.dataset.renders ?? "0") > b, before);
}

/** Waits for an action box to reach a state. */
const stateOf = (id: string, state: string) =>
  page.waitForSelector(`[id="${id}"][data-state="${state}"]`);

beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await closeBrowser(browser);
});

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "pixelguard-actions-"));
  await capture("baseline", {
    home: { desktop: "identical" },
    pricing: { desktop: "identical" },
  });
  await capture("current", {
    home: { desktop: "button-colour" },
    pricing: { desktop: "element-shift" },
  });
  db = getDatabase(":memory:");
  server = createApp({ db, outputDir: out, projectDir: out }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  page = await browser.newPage();
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    // Expected: 409s from refused actions, 404s for missing images.
    if (m.type() === "error" && !/status of (404|409)/.test(m.text())) pageErrors.push(m.text());
  });
});

afterEach(async () => {
  await page.close();
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
  db.close();
  await rm(out, { recursive: true, force: true });
});

describe("accepting a run (P043)", () => {
  it("offers accept only when something changed", async () => {
    const changed = saveTestRun([shot("home", "Real Bug"), shot("pricing")]);
    const clean = saveTestRun([shot("home"), shot("pricing")]);
    await open(`#/runs/${changed}`);
    expect(await page.locator("#accept #accept-all").count()).toBe(1);
    // Per-page button only on the page that changed.
    expect(await page.locator('[data-page="home"] .page-actions').count()).toBe(1);
    expect(await page.locator('[data-page="pricing"] .page-actions').count()).toBe(0);
    await navigate(`#/runs/${clean}`);
    expect(await page.locator("#accept").count()).toBe(0);
    expect(await page.locator("#app").textContent()).not.toContain("null");
    expect(pageErrors).toEqual([]);
  });

  it("asks before accepting, and Cancel changes nothing", async () => {
    const id = saveTestRun([shot("home", "Real Bug"), shot("pricing", "Uncertain")]);
    await open(`#/runs/${id}`);
    await page.click('#accept-all [data-role="start"]');
    await stateOf("accept-all", "confirming");
    await expect(page.locator("#accept-all .confirm p").textContent()).resolves.toBe(
      'Replace the whole "baseline" baseline with every page from "current"?'
    );
    // The confirm button gets focus, so Enter confirms from the keyboard.
    await expect(
      page.evaluate(() => document.activeElement?.getAttribute("data-role"))
    ).resolves.toBe("confirm");
    await page.click('#accept-all [data-role="cancel"]');
    await stateOf("accept-all", "idle");
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");
  });

  it("accepts the whole run and links to the history", async () => {
    const id = saveTestRun([shot("home", "Real Bug"), shot("pricing", "Uncertain")]);
    await open(`#/runs/${id}`);
    await page.click('#accept-all [data-role="start"]');
    await page.click('#accept-all [data-role="confirm"]');
    await stateOf("accept-all", "done");
    const message = await page.locator("#accept-all .notice--ok").textContent();
    expect(message).toContain(
      '2 screenshots from "current" are now the "baseline" baseline (version 2)'
    );
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
    expect(fixtureOf("baseline", "desktop/pricing.png")).toBe("element-shift");

    await page.click('#accept-all a[href="#/baselines/baseline"]');
    await page.waitForSelector("#history-table");
    // v1 is the original baseline, v2 this accept.
    expect(await page.locator("#history-table tbody tr").count()).toBe(2);
    expect(pageErrors).toEqual([]);
  });

  it("accepts a single page", async () => {
    const id = saveTestRun([shot("home", "Real Bug"), shot("pricing", "Uncertain")]);
    await open(`#/runs/${id}`);
    const box = '[id="accept-page-home"]';
    await page.click(`${box} [data-role="start"]`);
    await expect(page.locator(`${box} .confirm p`).textContent()).resolves.toContain(
      'Make the "current" screenshots of home the new "baseline" for this page?'
    );
    await page.click(`${box} [data-role="confirm"]`);
    await stateOf("accept-page-home", "done");
    await expect(page.locator(`${box} .notice--ok`).textContent()).resolves.toContain(
      '1 screenshot from "current" (home) are now'
    );
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
    expect(fixtureOf("baseline", "desktop/pricing.png")).toBe("identical");
  });

  it("offers to accept just the screenshots that worked", async () => {
    await capture("current", {
      home: { desktop: "button-colour", mobile: "FAIL" },
      pricing: { desktop: "element-shift" },
    });
    const id = saveTestRun([shot("home", "Real Bug")]);
    await open(`#/runs/${id}`);
    await page.click('#accept-all [data-role="start"]');
    await page.click('#accept-all [data-role="confirm"]');
    await stateOf("accept-all", "failed");
    const error = await page.locator("#accept-all .notice--error").textContent();
    expect(error).toContain("Nothing was changed.");
    expect(error).toContain("1 screenshot(s) failed");
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("identical");

    await page.click('#accept-all [data-role="fallback"]');
    await stateOf("accept-all", "done");
    await expect(page.locator("#accept-all .notice--ok").textContent()).resolves.toContain(
      "2 screenshots"
    );
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
  });

  it("explains a refusal and lets you try again", async () => {
    // The run is older than the current capture, so accepting is refused.
    const id = saveTestRun([shot("home", "Real Bug")], "2026-09-25T07:00:00.000Z");
    await open(`#/runs/${id}`);
    await page.click('#accept-all [data-role="start"]');
    await page.click('#accept-all [data-role="confirm"]');
    await stateOf("accept-all", "failed");
    await expect(page.locator("#accept-all .notice--error").textContent()).resolves.toContain(
      `has been re-captured since run ${id}`
    );
    expect(await page.locator('#accept-all [data-role="fallback"]').count()).toBe(0);
    await page.click('#accept-all [data-role="retry"]');
    await stateOf("accept-all", "failed");
    await page.click('#accept-all [data-role="cancel"]');
    await stateOf("accept-all", "idle");
  });
});

describe("baseline history (P043)", () => {
  /** Accepts twice through the API: v1 original, v2 home only, v3 everything. */
  async function makeHistory() {
    const id = saveTestRun([shot("home", "Real Bug")]);
    const post = (body: unknown) =>
      fetch(`${url}/api/runs/${id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ pages: ["home"] })).status).toBe(200); // v2: home changed
    expect((await post({})).status).toBe(200); // v3: everything
  }

  it("explains an empty history", async () => {
    await open("#/baselines");
    await expect(page.locator("#history-empty").textContent()).resolves.toContain(
      'No history for "baseline" yet.'
    );
    await expect(
      page.locator('nav a[href="#/baselines"]').getAttribute("aria-current")
    ).resolves.toBe("page");
  });

  it("lists versions newest first with how each was made", async () => {
    await makeHistory();
    await open("#/baselines/baseline");
    const rows = await page.locator("#history-table tbody tr").allTextContents();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("v3");
    expect(rows[0]).toContain('Accepted from "current" (all pages, 2 screenshots)');
    expect(rows[0]).toContain("Current");
    expect(rows[1]).toContain('Accepted from "current" (pages home, 1 screenshot)');
    expect(rows[1]).toContain("Archived");
    expect(rows[2]).toContain("Original baseline (from before the first accept)");
    // Only archived, non-current versions can be restored.
    expect(await page.locator('tr[data-version="3"] .action').count()).toBe(0);
    expect(await page.locator('tr[data-version="2"] .action').count()).toBe(1);
    expect(await page.locator('tr[data-version="1"] .action').count()).toBe(1);
  });

  it("restores an old version and refreshes the table", async () => {
    await makeHistory();
    await open("#/baselines/baseline");
    await page.click('[id="restore-v2"] [data-role="start"]');
    await expect(page.locator('[id="restore-v2"] .confirm p').textContent()).resolves.toContain(
      'Make version 2 the "baseline" baseline again?'
    );
    await page.click('[id="restore-v2"] [data-role="confirm"]');
    await page.waitForSelector('#notice [data-state="done"]');
    await expect(page.locator("#notice").textContent()).resolves.toContain(
      'Version 2 is the "baseline" baseline again, saved as version 4.'
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#history-table tbody tr").length === 4
    );
    const first = await page.locator("#history-table tbody tr").first().textContent();
    expect(first).toContain("Restored from version 2");
    expect(first).toContain("Current");
    // v2 had only home changed, so pricing is back to the original.
    expect(fixtureOf("baseline", "desktop/pricing.png")).toBe("identical");
    expect(fixtureOf("baseline", "desktop/home.png")).toBe("button-colour");
    expect(pageErrors).toEqual([]);
  });

  it("shows one version's screenshots and can restore from there", async () => {
    await makeHistory();
    await open("#/baselines/baseline/v2");
    await expect(page.locator("h1").textContent()).resolves.toBe('"baseline" version 2 Archived');
    expect(await page.locator("#app").textContent()).not.toContain("null");
    const images = await page
      .locator("#version-pages img")
      .evaluateAll((imgs) =>
        imgs.map(
          (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0
        )
      );
    expect(images).toEqual([true, true]);
    await page.click('[id="restore-v2"] [data-role="start"]');
    await page.click('[id="restore-v2"] [data-role="confirm"]');
    // Restoring saves a copy as a new version (v4); v2 itself stays archived.
    await page.waitForSelector(".notice--ok");
    await expect(page.locator(".notice--ok").textContent()).resolves.toContain(
      "saved as version 4"
    );
    await expect(page.locator("h1").textContent()).resolves.toBe('"baseline" version 2 Archived');
    await page.click('.notice--ok a[href="#/baselines/baseline"]');
    await page.waitForSelector('#history-table tr[data-version="4"].is-current');
  });

  it("says when a version isn't available", async () => {
    await makeHistory();
    await open("#/baselines/baseline/v9");
    await expect(page.locator("#not-found").textContent()).resolves.toContain(
      'Version 9 of "baseline" isn\'t available'
    );
  });
});

describe("router robustness (P043)", () => {
  it("never lets a slow page draw over a newer one", async () => {
    const id = saveTestRun([shot("home", "Real Bug")]);
    await open("#/trend");
    // Make the run request slow, start opening it, then move on before it answers.
    await page.route(`**/api/runs/${id}`, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue().catch(() => {});
    });
    await page.evaluate((i) => (location.hash = `#/runs/${i}`), id);
    await navigate("#/baselines");
    await page.waitForTimeout(1200);
    await expect(page.locator("h1").textContent()).resolves.toBe("Baseline history");
    expect(await page.locator("#run-headline").count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  it("shows server errors with a working Try again", async () => {
    let failures = 1;
    await page.route("**/api/runs?*", async (route) => {
      if (failures-- > 0) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid query", issues: ["limit: too big"] }),
        });
      } else {
        await route.continue();
      }
    });
    await open("#/runs");
    await expect(page.locator("#error").textContent()).resolves.toContain("Invalid query");
    await expect(page.locator("#error li").textContent()).resolves.toBe("limit: too big");
    const before = await renders();
    await page.click("#retry");
    await page.waitForFunction((b) => Number(document.body.dataset.renders ?? "0") > b, before);
    expect(await page.locator("#error").count()).toBe(0);
    expect(await page.locator("#empty").count()).toBe(1);
  });
});

describe("read-only dashboard (P047)", () => {
  /** Swaps this test's server for a read-only one on the same data. */
  async function restartReadOnly() {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    server = createApp({ db, outputDir: out, projectDir: out, readOnly: true }).listen(
      0,
      "127.0.0.1"
    );
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("shows the command line instead of accept buttons", async () => {
    const id = saveTestRun([shot("home", "Real Bug"), shot("pricing", "Uncertain")]);
    await restartReadOnly();
    await open(`#/runs/${id}`);
    expect(await page.locator("#read-only-badge").isVisible()).toBe(true);
    expect(await page.locator("#accept").count()).toBe(0);
    expect(await page.locator(".page-actions").count()).toBe(0);
    await expect(page.locator("#read-only-note code").textContent()).resolves.toBe(
      "pixelguard accept --from current --to baseline"
    );
    expect(pageErrors).toEqual([]);
  });

  it("lists history without restore buttons", async () => {
    const id = saveTestRun([shot("home", "Real Bug")]);
    // Make some history first (the normal server), then go read-only.
    const accepted = await fetch(`${url}/api/runs/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(accepted.status).toBe(200);
    await restartReadOnly();
    await open("#/baselines");
    expect(await page.locator("#history-table tbody tr").count()).toBe(2);
    expect(await page.locator("#history-table .action").count()).toBe(0);
    await expect(page.locator("#history-intro").textContent()).resolves.toContain(
      "This dashboard is read-only"
    );
    await navigate("#/baselines/baseline/v1");
    expect(await page.locator('[id="restore-v1"]').count()).toBe(0);
  });

  it("hides the badge on a normal dashboard", async () => {
    await open("#/runs");
    expect(await page.locator("#read-only-badge").isVisible()).toBe(false);
  });
});
