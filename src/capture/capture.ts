/**
 * Screenshot capture logic.
 *
 * Captures full-page screenshots for each configured page, across
 * each configured viewport, saved into a tagged folder.
 *
 * Tickets: P007, P008, P009, P010
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright";
import type { ViewportConfig } from "../config.js";
import {
  regionMatches,
  type DynamicRegion,
  type RegionRect,
  type ResolvedRegion,
} from "../judge/context.js";
import { buildPageUrl, pageName } from "./pages.js";
import {
  closePage,
  navigateTo,
  newPage,
  withBrowser,
  type LaunchOptions,
  type NavigateOptions,
} from "./browser.js";
import { tagDir, writeManifest, type CaptureManifest, type ManifestScreenshot } from "./storage.js";

// Viewport definitions live in config.ts (P011) so they can be overridden
// from .env; re-exported here for convenience.
export { DEFAULT_VIEWPORTS, type ViewportConfig } from "../config.js";
// Page naming lives in pages.ts (no Playwright dependency) so other layers
// can use it; re-exported here for convenience.
export { buildPageUrl, pageName } from "./pages.js";

export interface ScreenshotOptions extends NavigateOptions {
  /**
   * Scroll through the page before capturing so lazy-loaded images and
   * scroll-triggered content are rendered (default: true).
   */
  scrollToLoad?: boolean;
  /** Extra wait after loading/scrolling, in ms, before capturing (default: 250). */
  settleMs?: number;
  /**
   * Dynamic regions that apply to this screenshot (already filtered for the
   * page and viewport). Selector regions are measured just before capturing.
   */
  regions?: DynamicRegion[];
}

export interface ScreenshotResult {
  url: string;
  path: string;
  /** Size of the captured image in pixels (the full page, not just the viewport). */
  width: number;
  height: number;
  /** The regions passed in options.regions, with their boxes measured. */
  regions: ResolvedRegion[];
}

/** CSS injected before capturing: hides scrollbars, the text caret, and stops animations. */
const STABILIZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

/**
 * Scrolls down the page one viewport at a time (capped so infinite-scroll
 * pages can't loop forever), then back to the top.
 */
/**
 * Resolves regions to pixel boxes on the page: each element matching a
 * selector becomes one box (in full-page coordinates, skipping invisible
 * zero-size elements); rect regions pass through unchanged.
 */
export async function measureRegions(
  page: Page,
  regions: DynamicRegion[]
): Promise<ResolvedRegion[]> {
  const resolved: ResolvedRegion[] = [];
  for (const region of regions) {
    const base = { label: region.label, kind: region.kind, handling: region.handling };
    if (region.rect) {
      resolved.push({ ...base, rects: [region.rect] });
      continue;
    }
    const selector = region.selector as string;
    let rects: RegionRect[];
    try {
      rects = await page.evaluate((sel) => {
        return Array.from(document.querySelectorAll(sel))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => {
            const x = Math.max(0, Math.floor(r.left + window.scrollX));
            const y = Math.max(0, Math.floor(r.top + window.scrollY));
            return {
              x,
              y,
              width: Math.ceil(r.right + window.scrollX) - x,
              height: Math.ceil(r.bottom + window.scrollY) - y,
            };
          });
      }, selector);
    } catch (err) {
      throw new Error(
        `Invalid selector "${selector}" for region "${region.label}": ${(err as Error).message.split("\n")[0]}`
      );
    }
    resolved.push({ ...base, selector, rects });
  }
  return resolved;
}

async function scrollThroughPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const maxSteps = 50;
    for (let i = 0; i < maxSteps; i++) {
      const before = window.scrollY;
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 100));
      if (window.scrollY === before) break; // reached the bottom
    }
    window.scrollTo(0, 0);
  });
}

/**
 * Loads url in an already-open page and saves a full-page PNG screenshot to
 * outputPath (parent folders are created as needed).
 */
export async function captureScreenshot(
  page: Page,
  url: string,
  outputPath: string,
  options: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  const { scrollToLoad = true, settleMs = 250, regions = [], ...navigateOptions } = options;

  await navigateTo(page, url, navigateOptions);
  await page.addStyleTag({ content: STABILIZE_CSS });

  if (scrollToLoad) {
    await scrollThroughPage(page);
    // Give images revealed by scrolling a chance to finish loading.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  }
  // Make sure web fonts are ready so text renders the same every run.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (settleMs > 0) await page.waitForTimeout(settleMs);

  const measured = await measureRegions(page, regions);

  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    type: "png",
  });

  const size = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
  }));

  return { url, path: outputPath, ...size, regions: measured };
}

/**
 * Opens a fresh page at the given viewport, captures url to outputPath,
 * and closes the page again.
 */
export async function captureUrl(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number },
  outputPath: string,
  options: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  const page = await newPage(browser, viewport);
  try {
    return await captureScreenshot(page, url, outputPath, options);
  } finally {
    await closePage(page);
  }
}

export type ViewportCaptureOutcome =
  | { viewport: string; ok: true; result: ScreenshotResult }
  | { viewport: string; ok: false; error: Error };

/**
 * Captures url once per viewport (one after another, each in a fresh page).
 * outputPathFor decides where each viewport's PNG is saved.
 *
 * A failure in one viewport doesn't stop the others: every viewport gets an
 * outcome, either ok with its ScreenshotResult or not ok with the error.
 */
export async function captureViewports(
  browser: Browser,
  url: string,
  viewports: ViewportConfig[],
  outputPathFor: (viewport: ViewportConfig) => string,
  options: ScreenshotOptions = {},
  regionsFor?: (viewport: ViewportConfig) => DynamicRegion[]
): Promise<ViewportCaptureOutcome[]> {
  const outcomes: ViewportCaptureOutcome[] = [];
  for (const viewport of viewports) {
    try {
      const result = await captureUrl(
        browser,
        url,
        { width: viewport.width, height: viewport.height },
        outputPathFor(viewport),
        regionsFor ? { ...options, regions: regionsFor(viewport) } : options
      );
      outcomes.push({ viewport: viewport.name, ok: true, result });
    } catch (err) {
      outcomes.push({
        viewport: viewport.name,
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return outcomes;
}

export interface PageCaptureResult {
  /** The page path as configured, e.g. "/about". */
  page: string;
  /** File-safe name from pageName(), e.g. "about". */
  name: string;
  url: string;
  viewports: ViewportCaptureOutcome[];
}

/**
 * Captures every page at every viewport in a single run, reusing one browser.
 * outputPathFor decides where each page/viewport PNG is saved.
 *
 * Throws before capturing anything if two pages would get the same file name
 * (e.g. "/about-us" and "/about/us"), since their screenshots would overwrite
 * each other. Failures on individual pages or viewports are recorded in the
 * results rather than stopping the run.
 */
export async function capturePages(
  browser: Browser,
  baseUrl: string,
  pages: string[],
  viewports: ViewportConfig[],
  outputPathFor: (page: { page: string; name: string }, viewport: ViewportConfig) => string,
  options: ScreenshotOptions = {},
  onPage?: (result: PageCaptureResult) => void
): Promise<PageCaptureResult[]> {
  // Here options.regions is the full list; each screenshot gets only the
  // regions matching its page and viewport.
  const { regions: allRegions = [], ...screenshotOptions } = options;
  const named = pages.map((page) => ({ page, name: pageName(page) }));

  const seen = new Map<string, string>();
  for (const { page, name } of named) {
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(
        `Pages "${other}" and "${page}" would both be saved as "${name}". ` +
          `Remove one of them from TARGET_PAGES.`
      );
    }
    seen.set(name, page);
  }

  const results: PageCaptureResult[] = [];
  for (const entry of named) {
    const url = buildPageUrl(baseUrl, entry.page);
    const outcomes = await captureViewports(
      browser,
      url,
      viewports,
      (viewport) => outputPathFor(entry, viewport),
      screenshotOptions,
      (viewport) => allRegions.filter((r) => regionMatches(r, entry.name, viewport.name))
    );
    const pageResult = { ...entry, url, viewports: outcomes };
    results.push(pageResult);
    onPage?.(pageResult);
  }
  return results;
}

export interface CaptureRunOptions {
  baseUrl: string;
  pages: string[];
  viewports: ViewportConfig[];
  /** Root screenshots folder (Settings.outputDir). */
  outputDir: string;
  /** Tag to store this run under, e.g. "baseline" or "current". */
  tag: string;
  launch?: LaunchOptions;
  screenshot?: ScreenshotOptions;
  /** Called after each page finishes (all its viewports), e.g. to print progress. */
  onPage?: (result: PageCaptureResult) => void;
  /** Known dynamic regions (all pages); measured and recorded in the manifest. */
  regions?: DynamicRegion[];
}

export interface CaptureRunResult {
  /** Folder the run was saved to: <outputDir>/<tag>. */
  dir: string;
  manifest: CaptureManifest;
  succeeded: number;
  failed: number;
}

/**
 * Captures every page at every viewport and saves the run under
 * <outputDir>/<tag>/<viewport>/<page>.png, with a manifest.json.
 *
 * The run is written to a temporary folder first and only replaces the
 * existing tag once it finishes, so an interrupted or completely failed run
 * never wipes out a previous capture (like your baseline). Screenshots from
 * pages that were removed from the config don't linger either, because the
 * whole tag folder is replaced.
 *
 * Throws if every screenshot failed (the previous capture is kept).
 */
export async function captureAllPages(options: CaptureRunOptions): Promise<CaptureRunResult> {
  const { baseUrl, pages, viewports, outputDir, tag } = options;
  const finalDir = tagDir(outputDir, tag);
  const tempDir = join(outputDir, `.tmp-${tag}-${process.pid}-${Date.now()}`);

  try {
    const results = await withBrowser(
      (browser) =>
        capturePages(
          browser,
          baseUrl,
          pages,
          viewports,
          (page, viewport) => join(tempDir, viewport.name, `${page.name}.png`),
          { ...options.screenshot, regions: options.regions },
          options.onPage
        ),
      options.launch
    );

    const manifest: CaptureManifest = {
      tag,
      capturedAt: new Date().toISOString(),
      baseUrl,
      viewports: viewports.map(({ name, width, height }) => ({ name, width, height })),
      pages: results.map((r) => ({
        page: r.page,
        name: r.name,
        url: r.url,
        screenshots: r.viewports.map((v): ManifestScreenshot =>
          v.ok
            ? {
                viewport: v.viewport,
                ok: true,
                file: `${v.viewport}/${r.name}.png`,
                width: v.result.width,
                height: v.result.height,
                ...(v.result.regions.length > 0 && { regions: v.result.regions }),
              }
            : { viewport: v.viewport, ok: false, error: v.error.message }
        ),
      })),
    };

    const all = manifest.pages.flatMap((p) => p.screenshots);
    const succeeded = all.filter((s) => s.ok).length;
    const failed = all.length - succeeded;

    if (succeeded === 0) {
      const firstError = all.find((s) => !s.ok);
      throw new Error(
        `Every screenshot failed for tag "${tag}"` +
          (firstError && !firstError.ok ? ` (first error: ${firstError.error})` : "") +
          `. The previous "${tag}" capture was left unchanged.`
      );
    }

    await mkdir(tempDir, { recursive: true });
    await writeManifest(tempDir, manifest);
    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);

    return { dir: finalDir, manifest, succeeded, failed };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
