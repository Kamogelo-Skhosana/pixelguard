/**
 * Tests for the Playwright browser wrapper, run against a local HTTP server.
 *
 * Ticket: P006
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import {
  closeBrowser,
  closePage,
  launchBrowser,
  navigateTo,
  NavigationError,
  newPage,
  withBrowser,
} from "../src/capture/browser.js";

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Home</title></head><body><h1>Hello</h1></body></html>");
    } else if (req.url === "/empty-500") {
      res.writeHead(500);
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
});

afterAll(async () => {
  await closeBrowser(browser);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser wrapper", () => {
  it("launches a connected browser", () => {
    expect(browser.isConnected()).toBe(true);
  });

  it("opens a page with the requested viewport and loads a URL", async () => {
    const page = await newPage(browser, { width: 390, height: 844 });
    await navigateTo(page, `${baseUrl}/`);
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    expect(await page.title()).toBe("Home");
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    await closePage(page);
  });

  it("uses deterministic page settings", async () => {
    const page = await newPage(browser, { width: 800, height: 600 });
    await navigateTo(page, `${baseUrl}/`);
    const settings = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    expect(settings).toEqual({ dpr: 1, tz: "UTC", reducedMotion: true });
    await closePage(page);
  });

  it("closePage closes the page's context", async () => {
    const page = await newPage(browser, { width: 800, height: 600 });
    const context = page.context();
    await closePage(page);
    expect(page.isClosed()).toBe(true);
    expect(context.pages()).toHaveLength(0);
  });

  it("throws NavigationError with the status for HTTP errors", async () => {
    const page = await newPage(browser, { width: 800, height: 600 });
    const err = await navigateTo(page, `${baseUrl}/missing`).catch((e) => e);
    expect(err).toBeInstanceOf(NavigationError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/HTTP 404/);
    await closePage(page);
  });

  it("keeps the HTTP status for error responses with an empty body", async () => {
    const page = await newPage(browser, { width: 800, height: 600 });
    const err = await navigateTo(page, `${baseUrl}/empty-500`).catch((e) => e);
    expect(err).toBeInstanceOf(NavigationError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/HTTP 500/);
    await closePage(page);
  });

  it("throws NavigationError when the site is unreachable", async () => {
    const page = await newPage(browser, { width: 800, height: 600 });
    const err = await navigateTo(page, "http://127.0.0.1:1/", { timeoutMs: 5_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(NavigationError);
    expect(err.status).toBeUndefined();
    await closePage(page);
  });
});

describe("withBrowser", () => {
  it("returns the callback result and closes the browser", async () => {
    let inner: Browser | undefined;
    const result = await withBrowser(async (b) => {
      inner = b;
      return 42;
    });
    expect(result).toBe(42);
    expect(inner?.isConnected()).toBe(false);
  });

  it("closes the browser even when the callback throws", async () => {
    let inner: Browser | undefined;
    await expect(
      withBrowser(async (b) => {
        inner = b;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(inner?.isConnected()).toBe(false);
  });
});
