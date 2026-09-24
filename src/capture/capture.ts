/**
 * Screenshot capture logic.
 *
 * Captures full-page screenshots for each configured page, across
 * each configured viewport, saved into a tagged folder.
 *
 * Tickets: P007, P008, P009, P010
 */

export interface ViewportConfig {
  name: string; // e.g. "desktop", "mobile"
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORTS: ViewportConfig[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

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
