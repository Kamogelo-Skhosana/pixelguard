/**
 * Page naming helpers, kept free of Playwright so any layer can use them.
 *
 * Tickets: P009, P018
 */

/**
 * Turns a page path into a file-safe name used for its screenshots:
 * "/" -> "home", "/about" -> "about", "/blog/Post 1" -> "blog-post-1",
 * "/search?q=shoes" -> "search-q-shoes". Names are lowercase so they
 * behave the same on case-insensitive file systems (Windows, macOS).
 */
export function pageName(pagePath: string): string {
  const name = pagePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
  return name || "home";
}

/** Joins a base URL and a page path with exactly one slash between them. */
export function buildPageUrl(baseUrl: string, pagePath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pagePath.replace(/^\/+/, "")}`;
}
