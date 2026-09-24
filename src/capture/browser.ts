/**
 * Playwright browser wrapper.
 *
 * Handles launching a browser, opening a page at a given viewport,
 * navigating to a URL, and cleanup. Pages are configured for
 * deterministic screenshots (fixed scale, locale, timezone, colour
 * scheme, and reduced motion) so that re-runs of an unchanged site
 * produce identical pixels.
 *
 * Ticket: P006
 */

import { chromium, type Browser, type Page } from "playwright";

export interface LaunchOptions {
  /** Run without a visible window (default: true). */
  headless?: boolean;
  /**
   * Use a specific Chromium/Chrome binary instead of Playwright's bundled one.
   * Falls back to the PIXELGUARD_CHROMIUM_PATH environment variable.
   */
  executablePath?: string;
}

export interface NavigateOptions {
  /** Max time for the page to load, in ms (default: 30000). */
  timeoutMs?: number;
  /**
   * After "load", also wait up to this many ms for the network to go quiet,
   * so late-loading images/fonts are in the screenshot (default: 5000).
   * Pages that never go idle (polling, analytics) just continue after the wait.
   */
  networkIdleMs?: number;
}

/** Thrown when a page cannot be loaded or returns an HTTP error status. */
export class NavigationError extends Error {
  constructor(
    public readonly url: string,
    message: string,
    public readonly status?: number
  ) {
    super(`Failed to load ${url}: ${message}`);
    this.name = "NavigationError";
  }
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = options.executablePath ?? process.env.PIXELGUARD_CHROMIUM_PATH;
  return chromium.launch({
    headless: options.headless ?? true,
    ...(executablePath ? { executablePath } : {}),
  });
}

/**
 * Opens a new page in its own browser context with the given viewport.
 * Each page gets a fresh context, so cookies/storage never leak between captures.
 */
export async function newPage(
  browser: Browser,
  viewport: { width: number; height: number }
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  return context.newPage();
}

/**
 * Navigates to url and waits for it to finish loading.
 * Throws NavigationError on network failure, timeout, or an HTTP status >= 400.
 */
export async function navigateTo(
  page: Page,
  url: string,
  options: NavigateOptions = {}
): Promise<void> {
  const { timeoutMs = 30_000, networkIdleMs = 5_000 } = options;

  let response;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  } catch (err) {
    throw new NavigationError(url, (err as Error).message.split("\n")[0]);
  }

  if (response && response.status() >= 400) {
    throw new NavigationError(url, `HTTP ${response.status()}`, response.status());
  }

  if (networkIdleMs > 0) {
    await page.waitForLoadState("networkidle", { timeout: networkIdleMs }).catch(() => {
      // Some pages never go fully idle — that's fine, carry on.
    });
  }
}

/** Closes a page together with the browser context newPage() created for it. */
export async function closePage(page: Page): Promise<void> {
  await page.context().close();
}

export async function closeBrowser(browser: Browser): Promise<void> {
  await browser.close();
}

/**
 * Launches a browser, runs fn with it, and always closes the browser
 * afterwards — even if fn throws.
 */
export async function withBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
  options: LaunchOptions = {}
): Promise<T> {
  const browser = await launchBrowser(options);
  try {
    return await fn(browser);
  } finally {
    await closeBrowser(browser);
  }
}
