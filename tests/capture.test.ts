/**
 * Tests for the capture layer, run against a local HTTP server.
 *
 * Tickets: P006-P011
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, launchBrowser, NavigationError } from "../src/capture/browser.js";
import { captureUrl } from "../src/capture/capture.js";

const TALL_PAGE = `<!doctype html>
<html><head><style>
  body { margin: 0; }
  .block { height: 1000px; }
  #lazy { height: 200px; background: rgb(0, 0, 255); }
  #lazy.seen { background: rgb(255, 0, 0); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { animation: spin 1s linear infinite; width: 50px; height: 50px; background: #000; }
</style></head>
<body>
  <div class="spinner"></div>
  <div class="block" style="background: rgb(0, 255, 0)"></div>
  <div class="block" style="background: rgb(255, 255, 0)"></div>
  <div id="lazy"></div>
  <script>
    // Simulates lazy-loaded content: turns red only once scrolled into view.
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) document.getElementById("lazy").classList.add("seen");
    }).observe(document.getElementById("lazy"));
  </script>
</body></html>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let outDir: string;

function pixelAt(png: PNG, x: number, y: number): [number, number, number] {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/tall") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(TALL_PAGE);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
  outDir = await mkdtemp(join(tmpdir(), "pixelguard-capture-"));
});

afterAll(async () => {
  await closeBrowser(browser);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(outDir, { recursive: true, force: true });
});

describe("captureUrl", () => {
  it("saves a full-page PNG, creating parent folders (P007)", async () => {
    const path = join(outDir, "nested", "folders", "tall.png");
    const result = await captureUrl(browser, `${baseUrl}/tall`, { width: 800, height: 600 }, path);

    const png = PNG.sync.read(await readFile(path));
    // 50px spinner + 2 x 1000px blocks + 200px lazy block
    expect(png.width).toBe(800);
    expect(png.height).toBe(2250);
    expect(result).toEqual({ url: `${baseUrl}/tall`, path, width: 800, height: 2250 });
  });

  it("scrolls first so lazy content is rendered", async () => {
    const path = join(outDir, "lazy.png");
    await captureUrl(browser, `${baseUrl}/tall`, { width: 800, height: 600 }, path);
    const png = PNG.sync.read(await readFile(path));
    expect(pixelAt(png, 400, 2150)).toEqual([255, 0, 0]);
  });

  it("skips scrolling when scrollToLoad is false", async () => {
    const path = join(outDir, "no-scroll.png");
    await captureUrl(browser, `${baseUrl}/tall`, { width: 800, height: 600 }, path, {
      scrollToLoad: false,
    });
    const png = PNG.sync.read(await readFile(path));
    expect(pixelAt(png, 400, 2150)).toEqual([0, 0, 255]);
  });

  it("produces identical pixels on repeat captures of an unchanged page", async () => {
    const a = join(outDir, "repeat-a.png");
    const b = join(outDir, "repeat-b.png");
    await captureUrl(browser, `${baseUrl}/tall`, { width: 800, height: 600 }, a);
    await captureUrl(browser, `${baseUrl}/tall`, { width: 800, height: 600 }, b);
    expect(Buffer.compare(await readFile(a), await readFile(b))).toBe(0);
  });

  it("closes its page even when navigation fails", async () => {
    const before = browser.contexts().length;
    const err = await captureUrl(
      browser,
      `${baseUrl}/missing`,
      { width: 800, height: 600 },
      join(outDir, "missing.png")
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NavigationError);
    expect(browser.contexts().length).toBe(before);
  });
});

describe("captureAllPages", () => {
  it.todo("saves a screenshot per page/viewport combination under the given tag (P008-P010)");
});
