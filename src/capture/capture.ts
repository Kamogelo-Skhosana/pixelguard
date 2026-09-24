/**
 * Screenshot capture logic.
 *
 * Captures full-page screenshots for each configured page, across
 * each configured viewport, saved into a tagged folder.
 *
 * Tickets: P007, P008, P009, P010
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Browser, Page } from "playwright";
import type { ViewportConfig } from "../config.js";
import { closePage, navigateTo, newPage, type NavigateOptions } from "./browser.js";

// Viewport definitions live in config.ts (P011) so they can be overridden
// from .env; re-exported here for convenience.
export { DEFAULT_VIEWPORTS, type ViewportConfig } from "../config.js";

export interface ScreenshotOptions extends NavigateOptions {
  /**
   * Scroll through the page before capturing so lazy-loaded images and
   * scroll-triggered content are rendered (default: true).
   */
  scrollToLoad?: boolean;
  /** Extra wait after loading/scrolling, in ms, before capturing (default: 250). */
  settleMs?: number;
}

export interface ScreenshotResult {
  url: string;
  path: string;
  /** Size of the captured image in pixels (the full page, not just the viewport). */
  width: number;
  height: number;
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
  const { scrollToLoad = true, settleMs = 250, ...navigateOptions } = options;

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

  return { url, path: outputPath, ...size };
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
  options: ScreenshotOptions = {}
): Promise<ViewportCaptureOutcome[]> {
  const outcomes: ViewportCaptureOutcome[] = [];
  for (const viewport of viewports) {
    try {
      const result = await captureUrl(
        browser,
        url,
        { width: viewport.width, height: viewport.height },
        outputPathFor(viewport),
        options
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

export async function captureAllPages(
  _baseUrl: string,
  _pages: string[],
  _viewports: ViewportConfig[],
  _tag: string
): Promise<void> {
  // TODO (P009): for each page, call captureViewports() with baseUrl + page
  // and save each viewport's screenshot to
  // `screenshots/<tag>/<viewport>/<page>.png` (see P010 for the folder convention).
  throw new Error("Not implemented");
}
