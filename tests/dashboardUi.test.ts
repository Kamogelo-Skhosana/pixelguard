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
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function open(url: string) {
  await page.goto(url);
  await page.waitForSelector('body[data-ready="true"]');
}

async function navigate(hash: string) {
  await page.evaluate((h) => {
    document.body.dataset.ready = "false";
    location.hash = h;
  }, hash);
  await page.waitForSelector('body[data-ready="true"]');
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
    await expect(first.locator("td").nth(2).textContent()).resolves.toBe("blog.example.com/news");
    await expect(first.locator(".badge").textContent()).resolves.toBe("✗ FAIL");
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
    await page.click("text=Older →");
    await page.waitForSelector('body[data-ready="true"]');
    expect(page.url()).toMatch(/#\/runs\?page=2$/);
    expect(await rowIds()).toEqual([5, 4, 3, 2, 1]);
    await expect(page.locator("#page-info").textContent()).resolves.toBe(
      "26–30 of 30 runs · page 2 of 2"
    );

    await page.goBack();
    await page.waitForSelector('body[data-ready="true"]');
    expect((await rowIds())[0]).toBe(30);
  });

  it("filters by status, keeping the filter in the URL", async () => {
    await open(app.url);
    await page.selectOption("#status-filter", "fail");
    await page.waitForFunction(() => location.hash === "#/runs?status=fail");
    await page.waitForSelector('body[data-ready="true"]');
    expect(await rowIds()).toEqual([30, 27, 24, 21, 18, 15, 12, 9, 6, 3]);

    // Reloading keeps the filter.
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]');
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
