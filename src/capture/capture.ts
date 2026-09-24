/**
 * Screenshot capture logic.
 *
 * Captures full-page screenshots for each configured page, across
 * each configured viewport, saved into a tagged folder.
 *
 * Tickets: P007, P008, P009, P010
 */

import type { ViewportConfig } from "../config.js";

// Viewport definitions live in config.ts (P011) so they can be overridden
// from .env; re-exported here for convenience.
export { DEFAULT_VIEWPORTS, type ViewportConfig } from "../config.js";

export async function captureAllPages(
  _baseUrl: string,
  _pages: string[],
  _viewports: ViewportConfig[],
  _tag: string
): Promise<void> {
  // TODO (P007): for each page x viewport combination, launch a page
  // (browser.ts), navigate to baseUrl + page, take a full-page
  // screenshot, and save it to `screenshots/<tag>/<viewport>/<page>.png`
  // (see P010 for the folder convention).
  throw new Error("Not implemented");
}
