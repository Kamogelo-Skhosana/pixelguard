/**
 * Tests for the capture layer, run against a local HTTP server.
 *
 * Tickets: P006-P011
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, launchBrowser, NavigationError } from "../src/capture/browser.js";
import { listTags, readManifest } from "../src/capture/storage.js";
import {
  buildPageUrl,
  captureAllPages,
  capturePages,
  captureUrl,
  captureViewports,
  DEFAULT_VIEWPORTS,
  pageName,
} from "../src/capture/capture.js";

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

// Background colour depends on screen width: red on phones, green on tablets, blue on desktops.
const RESPONSIVE_PAGE = `<!doctype html>
<html><head><style>
  body { margin: 0; height: 100vh; background: rgb(255, 0, 0); }
  @media (min-width: 600px) { body { background: rgb(0, 255, 0); } }
  @media (min-width: 1024px) { body { background: rgb(0, 0, 255); } }
</style></head><body></body></html>`;

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
    if (req.url === "/" || req.url === "/about") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><title>${req.url}</title><body>Page ${req.url}</body>`);
    } else if (req.url === "/responsive") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(RESPONSIVE_PAGE);
    } else if (req.url === "/tall") {
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

describe("captureViewports", () => {
  it("captures one screenshot per viewport at the right size (P008)", async () => {
    const outcomes = await captureViewports(
      browser,
      `${baseUrl}/responsive`,
      DEFAULT_VIEWPORTS,
      (v) => join(outDir, "viewports", `${v.name}.png`)
    );

    expect(outcomes.map((o) => o.viewport)).toEqual(["desktop", "tablet", "mobile"]);
    expect(outcomes.every((o) => o.ok)).toBe(true);

    const expectedColour: Record<string, [number, number, number]> = {
      desktop: [0, 0, 255],
      tablet: [0, 255, 0],
      mobile: [255, 0, 0],
    };
    for (const viewport of DEFAULT_VIEWPORTS) {
      const png = PNG.sync.read(await readFile(join(outDir, "viewports", `${viewport.name}.png`)));
      expect(png.width).toBe(viewport.width);
      expect(png.height).toBe(viewport.height);
      expect(pixelAt(png, 10, 10)).toEqual(expectedColour[viewport.name]);
    }
  });

  it("keeps going when one viewport fails", async () => {
    // A file where a folder should be makes the tablet capture fail to save.
    const blocker = join(outDir, "blocker");
    await writeFile(blocker, "not a folder");

    const outcomes = await captureViewports(
      browser,
      `${baseUrl}/responsive`,
      DEFAULT_VIEWPORTS,
      (v) =>
        v.name === "tablet" ? join(blocker, "tablet.png") : join(outDir, "partial", `${v.name}.png`)
    );

    expect(outcomes.map((o) => [o.viewport, o.ok])).toEqual([
      ["desktop", true],
      ["tablet", false],
      ["mobile", true],
    ]);
    const failed = outcomes[1];
    expect(!failed.ok && failed.error).toBeInstanceOf(Error);
  });

  it("returns no outcomes for an empty viewport list", async () => {
    expect(await captureViewports(browser, `${baseUrl}/responsive`, [], () => "unused")).toEqual(
      []
    );
  });
});

describe("pageName", () => {
  it.each([
    ["/", "home"],
    ["", "home"],
    ["/about", "about"],
    ["/about/", "about"],
    ["/blog/Post 1", "blog-post-1"],
    ["/search?q=shoes&page=2", "search-q-shoes-page-2"],
    ["/checkout/", "checkout"],
  ])("%s -> %s", (input, expected) => {
    expect(pageName(input)).toBe(expected);
  });

  it("caps very long names at 100 characters", () => {
    expect(pageName("/" + "a".repeat(300)).length).toBe(100);
  });
});

describe("buildPageUrl", () => {
  it.each([
    ["http://x.com", "/", "http://x.com/"],
    ["http://x.com/", "/about", "http://x.com/about"],
    ["http://x.com/app", "settings", "http://x.com/app/settings"],
  ])("%s + %s -> %s", (base, page, expected) => {
    expect(buildPageUrl(base, page)).toBe(expected);
  });
});

describe("capturePages", () => {
  const twoViewports = DEFAULT_VIEWPORTS.filter((v) => v.name !== "tablet");

  it("captures every page at every viewport in one run (P009)", async () => {
    const results = await capturePages(browser, baseUrl, ["/", "/about"], twoViewports, (p, v) =>
      join(outDir, "pages", v.name, `${p.name}.png`)
    );

    expect(results.map((r) => [r.page, r.name, r.url])).toEqual([
      ["/", "home", `${baseUrl}/`],
      ["/about", "about", `${baseUrl}/about`],
    ]);
    for (const r of results) {
      expect(r.viewports.map((v) => [v.viewport, v.ok])).toEqual([
        ["desktop", true],
        ["mobile", true],
      ]);
    }
    for (const file of ["desktop/home", "desktop/about", "mobile/home", "mobile/about"]) {
      await expect(access(join(outDir, "pages", `${file}.png`))).resolves.toBeUndefined();
    }
  });

  it("records a failing page and still captures the rest", async () => {
    const results = await capturePages(
      browser,
      baseUrl,
      ["/missing", "/about"],
      twoViewports,
      (p, v) => join(outDir, "mixed", v.name, `${p.name}.png`)
    );
    expect(results[0].viewports.every((v) => !v.ok)).toBe(true);
    expect(results[1].viewports.every((v) => v.ok)).toBe(true);
  });

  it("refuses pages whose file names would collide, before capturing anything", async () => {
    await expect(
      capturePages(browser, baseUrl, ["/about-us", "/about/us"], twoViewports, () => {
        throw new Error("should not capture");
      })
    ).rejects.toThrow(/"\/about-us" and "\/about\/us" would both be saved as "about-us"/);
  });
});

describe("captureAllPages", () => {
  const viewports = DEFAULT_VIEWPORTS.filter((v) => v.name !== "tablet");
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false
    );

  it("saves <outputDir>/<tag>/<viewport>/<page>.png plus a manifest (P010)", async () => {
    const outputDir = join(outDir, "run-basic");
    const run = await captureAllPages({
      baseUrl,
      pages: ["/", "/about"],
      viewports,
      outputDir,
      tag: "baseline",
    });

    expect(run.dir).toBe(join(outputDir, "baseline"));
    expect(run.succeeded).toBe(4);
    expect(run.failed).toBe(0);
    for (const file of ["desktop/home", "desktop/about", "mobile/home", "mobile/about"]) {
      expect(await exists(join(outputDir, "baseline", `${file}.png`))).toBe(true);
    }

    const manifest = await readManifest(outputDir, "baseline");
    expect(manifest).toEqual(run.manifest);
    expect(manifest.tag).toBe("baseline");
    expect(manifest.baseUrl).toBe(baseUrl);
    expect(manifest.pages.map((p) => p.name)).toEqual(["home", "about"]);
    expect(manifest.pages[0].screenshots[0]).toMatchObject({
      viewport: "desktop",
      ok: true,
      file: "desktop/home.png",
      width: 1440,
    });
  });

  it("keeps baseline and current side by side", async () => {
    const outputDir = join(outDir, "run-tags");
    for (const tag of ["baseline", "current"]) {
      await captureAllPages({ baseUrl, pages: ["/"], viewports, outputDir, tag });
    }
    expect(await listTags(outputDir)).toEqual(["baseline", "current"]);
  });

  it("replaces a tag completely on re-capture, removing stale pages", async () => {
    const outputDir = join(outDir, "run-replace");
    await captureAllPages({
      baseUrl,
      pages: ["/", "/about"],
      viewports,
      outputDir,
      tag: "current",
    });
    await captureAllPages({ baseUrl, pages: ["/"], viewports, outputDir, tag: "current" });

    expect(await exists(join(outputDir, "current", "desktop", "home.png"))).toBe(true);
    expect(await exists(join(outputDir, "current", "desktop", "about.png"))).toBe(false);
    expect((await readManifest(outputDir, "current")).pages).toHaveLength(1);
  });

  it("records failed screenshots in the manifest", async () => {
    const outputDir = join(outDir, "run-partial");
    const run = await captureAllPages({
      baseUrl,
      pages: ["/", "/missing"],
      viewports,
      outputDir,
      tag: "current",
    });
    expect([run.succeeded, run.failed]).toEqual([2, 2]);
    expect(run.manifest.pages[1].screenshots[0]).toMatchObject({ ok: false, viewport: "desktop" });
    expect(await exists(join(outputDir, "current", "desktop", "missing.png"))).toBe(false);
  });

  it("keeps the previous capture when every screenshot fails", async () => {
    const outputDir = join(outDir, "run-allfail");
    await captureAllPages({ baseUrl, pages: ["/"], viewports, outputDir, tag: "baseline" });
    const before = await readManifest(outputDir, "baseline");

    await expect(
      captureAllPages({ baseUrl, pages: ["/missing"], viewports, outputDir, tag: "baseline" })
    ).rejects.toThrow(/Every screenshot failed.*HTTP 404.*left unchanged/);

    expect(await readManifest(outputDir, "baseline")).toEqual(before);
    expect(await exists(join(outputDir, "baseline", "desktop", "home.png"))).toBe(true);
    // No leftover temp folders.
    expect(await readdir(outputDir)).toEqual(["baseline"]);
  });

  it("rejects an invalid tag before launching a browser", async () => {
    await expect(
      captureAllPages({ baseUrl, pages: ["/"], viewports, outputDir: outDir, tag: "../oops" })
    ).rejects.toThrow(/Invalid tag/);
  });
});
