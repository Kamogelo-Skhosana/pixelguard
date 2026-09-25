/**
 * Browser tests for the dashboard's run list page, using real Chromium
 * against the real app with a seeded database.
 *
 * Ticket: P039
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, launchBrowser } from "../src/capture/browser.js";
import { createApp } from "../src/dashboard/app.js";
import type { DiffResult, Verdict } from "../src/diff/models.js";
import { getDatabase, saveRun } from "../src/report/persistence.js";

let browser: Browser;
let page: Page;
let pageErrors: string[];

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

/** Starts the app on a free port with the given database. */
async function serve(db: Database.Database): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createApp({ db }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closeServer(server),
  };
}

/**
 * Stops a test server without waiting for the browser's keep-alive
 * connections (the page is still open until afterEach), which could
 * otherwise hold server.close() open under heavy load.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

const renders = () => page.evaluate(() => Number(document.body.dataset.renders ?? "0"));

/**
 * Loads a URL and waits for the app's first render. Waits for
 * DOMContentLoaded (the app's module script has run by then) rather than the
 * full load event, and reports page errors and HTML if it ever times out.
 */
async function open(url: string) {
  // Both waits together stay under the 30s test timeout, so a hang is
  // reported with the details below rather than as a bare timeout.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
  try {
    await page.waitForFunction(() => Number(document.body.dataset.renders ?? "0") >= 1, undefined, {
      timeout: 12_000,
    });
  } catch (err) {
    const html = (await page.content()).slice(0, 500);
    throw new Error(
      `The dashboard didn't render ${url}. Page errors: ${JSON.stringify(pageErrors)}. HTML: ${html}`,
      { cause: err }
    );
  }
}

/**
 * Runs an action that changes the route, then waits for the app to finish
 * the next render. (Waiting on a "ready" flag would race: it's still true
 * from the previous render until the browser fires hashchange.)
 */
async function settled(action: () => Promise<unknown>) {
  const before = await renders();
  await action();
  await page.waitForFunction((b) => Number(document.body.dataset.renders ?? "0") > b, before);
}

async function navigate(hash: string) {
  await settled(() => page.evaluate((h) => (location.hash = h), hash));
}

const rowIds = () =>
  page
    .locator(".run-row")
    .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-run-id"))));

beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await closeBrowser(browser);
});
beforeEach(async () => {
  page = await browser.newPage();
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
});
afterEach(async () => {
  await page.close();
});

describe("run list page (P039)", () => {
  let db: Database.Database;
  let app: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    db = getDatabase(":memory:");
    // 30 runs, oldest first: every 3rd fails, every 5th needs review, the rest pass.
    for (let i = 1; i <= 30; i++) {
      const verdict: Verdict | undefined =
        i % 3 === 0 ? "Real Bug" : i % 5 === 0 ? "Uncertain" : undefined;
      saveRun(db, {
        results: [shot("home", verdict), shot("about")],
        targetUrl: i === 30 ? "https://blog.example.com/news" : "https://shop.example.com",
        baselineTag: "baseline",
        currentTag: "current",
        changeDescription:
          i === 29
            ? "<img src=x onerror=\"document.title='hacked'\">"
            : i === 30
              ? "New blog layout"
              : undefined,
        createdAt: new Date(Date.UTC(2026, 8, 1, 8) + i * 3_600_000),
      });
    }
    app = await serve(db);
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it("lists the newest 25 runs with their details", async () => {
    await open(app.url);
    expect(await rowIds()).toEqual(Array.from({ length: 25 }, (_, i) => 30 - i));

    const first = page.locator('.run-row[data-run-id="30"]');
    await expect(first.locator(".target").textContent()).resolves.toBe("blog.example.com/news");
    await expect(first.locator("td").nth(2).textContent()).resolves.toContain("baseline → current");
    await expect(first.locator(".badge").textContent()).resolves.toBe("✗ Failing");
    await expect(first.locator(".summary").textContent()).resolves.toContain(
      "1 real bug on 1 page (2 pages checked)"
    );
    await expect(first.locator(".note").textContent()).resolves.toBe("“New blog layout”");
    await expect(page.locator("#page-info").textContent()).resolves.toBe(
      "1–25 of 30 runs · page 1 of 2"
    );
    expect(pageErrors).toEqual([]);
  });

  it("pages to older runs and back", async () => {
    await open(app.url);
    await settled(() => page.click("text=Older →"));
    expect(page.url()).toMatch(/#\/runs\?page=2$/);
    expect(await rowIds()).toEqual([5, 4, 3, 2, 1]);
    await expect(page.locator("#page-info").textContent()).resolves.toBe(
      "26–30 of 30 runs · page 2 of 2"
    );

    await settled(() => page.goBack());
    expect((await rowIds())[0]).toBe(30);
  });

  it("filters by status, keeping the filter in the URL", async () => {
    await open(app.url);
    await settled(() => page.selectOption("#status-filter", "fail"));
    expect(page.url()).toMatch(/#\/runs\?status=fail$/);
    expect(await rowIds()).toEqual([30, 27, 24, 21, 18, 15, 12, 9, 6, 3]);

    // Reloading keeps the filter.
    await page.reload();
    await page.waitForFunction(() => Number(document.body.dataset.renders ?? "0") >= 1);
    await expect(page.locator("#status-filter").inputValue()).resolves.toBe("fail");
  });

  it("shows a message when a filter matches nothing", async () => {
    const empty = getDatabase(":memory:");
    saveRun(empty, { results: [shot("home")], baselineTag: "b", currentTag: "c" });
    const other = await serve(empty);
    try {
      await open(`${other.url}/#/runs?status=fail`);
      await expect(page.locator("#empty").textContent()).resolves.toContain(
        "No runs match this filter."
      );
    } finally {
      await other.close();
      empty.close();
    }
  });

  it("opens a run when its row is clicked", async () => {
    await open(app.url);
    await page.click('.run-row[data-run-id="28"] td:nth-child(3)');
    await page.waitForFunction(() => location.hash === "#/runs/28");
  });

  it("shows run data as text, never as HTML", async () => {
    await open(app.url);
    const note = await page.locator('.run-row[data-run-id="29"] .note').textContent();
    expect(note).toContain('<img src=x onerror="document.title=');
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.title()).toBe("pixelguard dashboard");
  });

  it("ignores a nonsense page number or status in the URL", async () => {
    await open(`${app.url}/#/runs?page=abc&status=evil`);
    expect((await rowIds())[0]).toBe(30);
    await expect(page.locator("#status-filter").inputValue()).resolves.toBe("");
  });

  it("shows a not-found page for unknown routes", async () => {
    await open(app.url);
    await navigate("#/nowhere");
    await expect(page.locator("h1").textContent()).resolves.toBe("Page not found");
  });
});

describe("run list states (P039)", () => {
  it("explains that there are no runs yet", async () => {
    const db = getDatabase(":memory:");
    const app = await serve(db);
    try {
      await open(app.url);
      await expect(page.locator("#empty").textContent()).resolves.toContain("No runs yet.");
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("shows the API's error message when loading fails", async () => {
    const db = getDatabase(":memory:");
    const app = await serve(db);
    db.close(); // every query now fails with a 500
    const quiet = console.error;
    console.error = () => {};
    try {
      await open(app.url);
      await expect(page.locator("#error").textContent()).resolves.toContain(
        "Something went wrong on the server"
      );
    } finally {
      console.error = quiet;
      await app.close();
    }
  });
});

describe("frontend delivery (P039)", () => {
  it("serves the page with strict security headers and JS modules with the right type", async () => {
    const db = getDatabase(":memory:");
    const app = await serve(db);
    try {
      const html = await fetch(`${app.url}/`);
      expect(html.headers.get("content-type")).toMatch(/text\/html/);
      expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(html.headers.get("x-frame-options")).toBe("DENY");
      expect(html.headers.get("x-content-type-options")).toBe("nosniff");
      const js = await fetch(`${app.url}/js/app.js`);
      expect(js.headers.get("content-type")).toMatch(/javascript/);
      // API errors are still JSON, not the HTML page.
      expect((await fetch(`${app.url}/api/nope`)).headers.get("content-type")).toMatch(/json/);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("run detail page (P040)", () => {
  let db: Database.Database;
  let app: { url: string; close: () => Promise<void> };
  const fx = (name: string, file: string) => `tests/fixtures/diff/${name}/${file}.png`;

  beforeAll(async () => {
    db = getDatabase(":memory:");
    saveRun(db, {
      targetUrl: "https://shop.example.com",
      baselineTag: "baseline",
      currentTag: "current",
      changeDescription: "Updated the homepage date",
      createdAt: new Date("2026-09-25T08:00:00.000Z"),
      results: [
        {
          ...shot("pricing", "Real Bug"),
          viewport: "desktop",
          pixelDiffCount: 1200,
          totalPixels: 24000,
          percentChanged: 5,
          explanation: "Cards overlap. <img src=x onerror=\"document.title='hacked'\">",
          observedChanges: ["Cards overlap", "Borders cut through prices"],
          ignoredRegions: [{ label: "Live clock", rect: { x: 0, y: 0, width: 5, height: 5 } }],
          baselineImagePath: fx("button-colour", "baseline"),
          currentImagePath: fx("button-colour", "current"),
          diffImagePath: fx("element-shift", "current"),
        },
        {
          ...shot("pricing", "Acceptable Change"),
          viewport: "mobile",
          sizeChanged: true,
          baselineSize: { width: 390, height: 900 },
          currentSize: { width: 390, height: 1000 },
          baselineImagePath: fx("identical", "baseline"),
          currentImagePath: fx("identical", "current"),
          diffImagePath: "tests/fixtures/diff/cleaned-up.png",
        },
        {
          ...shot("home"),
          viewport: "desktop",
          changed: true,
          pixelDiffCount: 3,
          percentChanged: 0.001,
          verdict: "Uncertain",
          explanation: "Could not be judged automatically: LLM API error 529",
          judgeError: "LLM API error 529",
          judgedBy: "claude-sonnet-5",
          baselineImagePath: fx("identical", "baseline"),
          currentImagePath: fx("identical", "current"),
          diffImagePath: fx("identical", "current"),
        },
        { ...shot("home"), viewport: "mobile" },
        { ...shot("about"), viewport: "desktop" },
      ],
      skipped: [{ page: "blog", viewport: "desktop", reason: 'not in "current" (removed page?)' }],
    });
    app = await serve(db);
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  const card = (pageName: string, viewport: string) =>
    page.locator(`details[data-page="${pageName}"] .shot[data-viewport="${viewport}"]`);

  it("shows the run header with its summary and developer note", async () => {
    await open(`${app.url}/#/runs/1`);
    await expect(page.locator("h1").textContent()).resolves.toBe("Run #1 ✗ Failing");
    await expect(page.locator("#run-headline").textContent()).resolves.toContain(
      "1 real bug on 1 page"
    );
    await expect(page.locator(".meta").textContent()).resolves.toContain(
      "https://shop.example.com"
    );
    await expect(page.locator(".change-note").textContent()).resolves.toContain(
      "Updated the homepage date"
    );
    // The only error allowed is the deliberately cleaned-up image's 404.
    expect(pageErrors.filter((e) => !e.includes("404"))).toEqual([]);
  });

  it("lists pages worst first, with passing pages collapsed", async () => {
    await open(`${app.url}/#/runs/1`);
    const pages = await page
      .locator("details.page")
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute("data-page"), (e as HTMLDetailsElement).open])
      );
    expect(pages).toEqual([
      ["pricing", true],
      ["home", true],
      ["blog", true],
      ["about", false],
    ]);
  });

  it("shows a changed screenshot's verdict, numbers, explanation and what the judge saw", async () => {
    await open(`${app.url}/#/runs/1`);
    const c = card("pricing", "desktop");
    await expect(c.locator(".badge").textContent()).resolves.toBe("Real Bug (9/10)");
    const facts = await c.locator(".facts").textContent();
    expect(facts).toContain("5.00% of the page (1,200 pixels)");
    expect(facts).toContain("Ignored regions: Live clock");
    await expect(c.locator(".observed li").allTextContents()).resolves.toEqual([
      "Cards overlap",
      "Borders cut through prices",
    ]);
  });

  it("shows baseline, current and diff images side by side, each linking to full size", async () => {
    await open(`${app.url}/#/runs/1`);
    const imgs = card("pricing", "desktop").locator(".images img");
    await expect(imgs.count()).resolves.toBe(3);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[data-viewport="desktop"] .images img')).every(
        (i) => (i as HTMLImageElement).complete
      )
    );
    const widths = await imgs.evaluateAll((els) =>
      els.map((e) => (e as HTMLImageElement).naturalWidth)
    );
    expect(widths.every((w) => w > 0)).toBe(true);
    const captions = await card("pricing", "desktop").locator("figcaption").allTextContents();
    expect(captions).toEqual(["Baseline", "Current", "Diff"]);
    const href = await card("pricing", "desktop").locator(".images a").first().getAttribute("href");
    expect(href).toMatch(/^\/api\/runs\/1\/diffs\/\d+\/baseline$/);
  });

  it("shows a placeholder when an image has been cleaned up", async () => {
    await open(`${app.url}/#/runs/1`);
    const missing = card("pricing", "mobile").locator(".missing");
    await missing.waitFor();
    await expect(missing.textContent()).resolves.toContain("no longer available");
    const facts = await card("pricing", "mobile").locator(".facts").textContent();
    expect(facts).toContain("height 900px → 1000px");
  });

  it("shows a failed judgement with its error", async () => {
    await open(`${app.url}/#/runs/1`);
    const c = card("home", "desktop");
    await expect(c.locator(".badge").textContent()).resolves.toBe("Couldn't be judged");
    await expect(c.locator(".explanation").textContent()).resolves.toBe("LLM API error 529");
    await expect(c.locator(".facts").textContent()).resolves.toContain("<0.01% of the page");
    await expect(page.locator('details[data-page="home"] .unchanged').textContent()).resolves.toBe(
      "Unchanged: mobile."
    );
  });

  it("shows skipped screenshots with their reason and no images", async () => {
    await open(`${app.url}/#/runs/1`);
    const c = card("blog", "desktop");
    await expect(c.locator(".badge").textContent()).resolves.toBe("Not compared");
    await expect(c.locator(".facts").textContent()).resolves.toContain(
      'not in "current" (removed page?)'
    );
    await expect(c.locator(".images").count()).resolves.toBe(0);
  });

  it("shows explanations as text, never as HTML", async () => {
    await open(`${app.url}/#/runs/1`);
    const text = await card("pricing", "desktop").locator(".explanation").textContent();
    expect(text).toContain("<img src=x onerror=");
    expect(await page.title()).toBe("pixelguard dashboard");
    expect(await page.locator(".explanation img").count()).toBe(0);
  });

  it("opens from the run list and goes back", async () => {
    await open(app.url);
    await page.click('.run-row[data-run-id="1"] td:nth-child(3)');
    await page.waitForFunction(() => location.hash === "#/runs/1");
    await page.waitForSelector("#pages");
    await page.click("text=← All runs");
    await page.waitForSelector("#runs-table");
  });

  it("says when a run doesn't exist", async () => {
    await open(`${app.url}/#/runs/999`);
    await expect(page.locator("#not-found").textContent()).resolves.toContain(
      "There's no run #999"
    );
  });
});

describe("trend page (P041)", () => {
  let db: Database.Database;
  let app: { url: string; close: () => Promise<void> };
  let emptyDb: Database.Database;
  let emptyApp: { url: string; close: () => Promise<void> };
  const runIds: number[] = [];

  /** Like serve(), but with a fixed "now" so the trend window is stable. */
  async function serveAt(database: Database.Database) {
    const server: Server = createApp({
      db: database,
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => closeServer(server),
    };
  }

  const save = (results: DiffResult[], iso: string) =>
    runIds.push(
      saveRun(db, {
        results,
        targetUrl: "https://shop.example.com",
        baselineTag: "baseline",
        currentTag: "current",
        createdAt: new Date(iso),
      })
    );

  beforeAll(async () => {
    db = getDatabase(":memory:");
    save([shot("home"), shot("about")], "2026-08-01T10:00:00.000Z"); // outside 30 days
    save([shot("home"), shot("about")], "2026-09-20T10:00:00.000Z"); // all pass
    save([shot("home", "Real Bug"), shot("about")], "2026-09-24T10:00:00.000Z");
    save([shot("home", "Uncertain"), shot("about")], "2026-09-24T11:00:00.000Z");
    app = await serveAt(db);
    emptyDb = getDatabase(":memory:");
    emptyApp = await serveAt(emptyDb);
  });

  afterAll(async () => {
    await app.close();
    await emptyApp.close();
    db.close();
    emptyDb.close();
  });

  const tileValue = (id: string) => page.locator(`#${id} .tile-value`).textContent();

  it("shows totals and one bar per day for the last 30 days", async () => {
    await open(`${app.url}/#/trend`);
    await expect(page.locator("h1").textContent()).resolves.toBe("Regressions over time");
    await expect(page.locator("#trend-range").textContent()).resolves.toBe(
      "2026-08-27 to 2026-09-25 (UTC)"
    );
    expect(await tileValue("tile-runs")).toBe("3");
    expect(await tileValue("tile-failing")).toBe("1");
    expect(await tileValue("tile-review")).toBe("1");
    expect(await tileValue("tile-bugs")).toBe("1");
    expect(await tileValue("tile-rate")).toBe("17%"); // 1 of 6 pages
    expect(await page.locator("#trend-chart .bar").count()).toBe(30);
    expect(await page.locator("#trend-chart .bar--empty").count()).toBe(28);
    expect(await page.locator("#trend-chart .seg--fail").count()).toBe(1);
    expect(await page.locator("#trend-chart .seg--review").count()).toBe(1);
    expect(await page.locator("#trend-chart .seg--pass").count()).toBe(1);
    expect(await page.locator("#trend-chart .bug-marker").count()).toBe(1);
    await expect(page.locator('nav a[href="#/trend"]').getAttribute("aria-current")).resolves.toBe(
      "page"
    );
    expect(await page.locator('nav a[href="#/runs"]').getAttribute("aria-current")).toBeNull();
    expect(pageErrors).toEqual([]);
  });

  it("describes a bar on hover and keyboard focus", async () => {
    await open(`${app.url}/#/trend`);
    const bar = page.locator('#trend-chart .bar[data-label="2026-09-24"]');
    await bar.hover();
    await expect(page.locator("#chart-readout").textContent()).resolves.toBe(
      "24 Sep: 1 failing, 1 needs review, 1 real bug of 4 pages, 2 runs"
    );
    await page.locator('#trend-chart .bar[data-label="2026-09-23"]').focus();
    await expect(page.locator("#chart-readout").textContent()).resolves.toBe("23 Sep: no runs");
    await expect(bar.getAttribute("aria-label")).resolves.toContain("24 Sep: 1 failing");
  });

  it("lists only days with runs in the data table", async () => {
    await open(`${app.url}/#/trend`);
    await page.locator("#trend-table summary").click();
    const rows = await page.locator("#trend-table tbody tr").allTextContents();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("20 Sep");
    expect(rows[1]).toContain("24 Sep");
  });

  it("switches to per-run bars that open the run", async () => {
    await open(`${app.url}/#/trend`);
    await settled(() => page.selectOption("#trend-period", "run"));
    expect(page.url()).toContain("#/trend?period=run&days=30");
    const labels = await page
      .locator("#trend-chart .bar")
      .evaluateAll((bars) => bars.map((b) => b.getAttribute("aria-label")));
    expect(labels).toEqual([
      `Run #${runIds[1]}: 0 failing, 0 needs review of 2 pages`,
      `Run #${runIds[2]}: 1 failing, 0 needs review, 1 real bug of 2 pages`,
      `Run #${runIds[3]}: 0 failing, 1 needs review of 2 pages`,
    ]);
    await settled(() => page.locator("#trend-chart .bar").nth(1).click());
    expect(page.url()).toContain(`#/runs/${runIds[2]}`);
    await expect(page.locator("#run-headline").count()).resolves.toBe(1);
  });

  it("groups by week and widens the range", async () => {
    await open(`${app.url}/#/trend?period=week`);
    const labels = await page.locator("#trend-chart .x-label").allTextContents();
    expect(labels.every((l) => l.startsWith("w/c "))).toBe(true);
    expect(labels).toContain("w/c 21 Sep");
    await settled(() => page.selectOption("#trend-days", "90"));
    expect(page.url()).toContain("#/trend?period=week&days=90");
    expect(await tileValue("tile-runs")).toBe("4");
  });

  it("falls back to defaults for unknown options", async () => {
    await open(`${app.url}/#/trend?period=hour&days=5`);
    await expect(page.locator("#trend-period").inputValue()).resolves.toBe("day");
    await expect(page.locator("#trend-days").inputValue()).resolves.toBe("30");
    expect(await page.locator("#trend-chart .bar").count()).toBe(30);
  });

  it("shows an empty state when there are no runs", async () => {
    await open(`${emptyApp.url}/#/trend`);
    await expect(page.locator("#trend-empty").textContent()).resolves.toContain(
      "No runs in the last 30 days."
    );
    expect(await page.locator("#trend-chart").count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});

describe("theme (P042)", () => {
  let db: Database.Database;
  let app: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    db = getDatabase(":memory:");
    app = await serve(db);
  });
  afterAll(async () => {
    await app.close();
    db.close();
  });

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const toggle = () => page.locator("#theme-toggle");

  it("serves the theme script, favicon and brand mark", async () => {
    const js = await fetch(`${app.url}/js/theme.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    const icon = await fetch(`${app.url}/favicon.svg`);
    expect(icon.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    await open(`${app.url}/`);
    expect(await page.locator(".brand .brand-mark").count()).toBe(1);
    await expect(page.locator(".brand").textContent()).resolves.toContain("pixelguard");
    expect(pageErrors).toEqual([]);
  });

  it("follows the system colour scheme by default", async () => {
    await page.emulateMedia({ colorScheme: "light" });
    await open(`${app.url}/`);
    await expect(toggle().textContent()).resolves.toBe("Theme: auto");
    expect(await themeAttr()).toBeNull();
    const light = await background();
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await background();
    expect(light).toBe("rgb(243, 245, 247)");
    expect(dark).toBe("rgb(18, 23, 30)");
  });

  it("cycles auto, light, dark and remembers the choice", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    await open(`${app.url}/`);
    await toggle().click();
    expect(await themeAttr()).toBe("light");
    await expect(toggle().textContent()).resolves.toBe("Theme: light");
    expect(await background()).toBe("rgb(243, 245, 247)"); // light wins over the dark system
    await toggle().click();
    expect(await themeAttr()).toBe("dark");
    await expect(toggle().getAttribute("aria-label")).resolves.toBe(
      "Colour theme: dark. Click to switch to auto."
    );

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await themeAttr()).toBe("dark"); // remembered
    expect(await background()).toBe("rgb(18, 23, 30)");

    await toggle().click();
    expect(await themeAttr()).toBeNull();
    await expect(toggle().textContent()).resolves.toBe("Theme: auto");
    expect(await background()).toBe("rgb(243, 245, 247)");
  });

  it("ignores a corrupted saved theme", async () => {
    await open(`${app.url}/`);
    await page.evaluate(() => localStorage.setItem("pixelguard-theme", "neon"));
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await themeAttr()).toBeNull();
    await expect(toggle().textContent()).resolves.toBe("Theme: auto");
  });
});
