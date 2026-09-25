/**
 * A small demo shop used by the end-to-end test and `npm run demo`.
 *
 * Version 1 is the baseline. Version 2 makes three kinds of change:
 *   - home:    the "last updated" date changes           -> should be Acceptable
 *   - pricing: a CSS mistake breaks the card layout      -> should be a Real Bug
 *   - blog:    nothing changes
 * Add ?version=1 or ?version=2 to any URL to view that version in a browser.
 * Every page also shows a live clock, which changes on every capture; the
 * demo regions file marks it "ignore" so it never counts as a change.
 *
 * Tickets: P034, P049
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type DemoVersion = 1 | 2;

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1f2933; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: center;
           padding: 16px 24px; background: #102a43; color: #fff; }
  header nav a { color: #d9e2ec; margin-left: 16px; text-decoration: none; }
  #live-clock { font-variant-numeric: tabular-nums; color: #9fb3c8; }
  main { padding: 32px 24px; max-width: 960px; margin: 0 auto; }
  h1 { margin: 0 0 12px; font-size: 32px; }
  p { line-height: 1.5; }
  .muted { color: #627d98; font-size: 14px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; }
  .card { flex: 1 1 240px; border: 1px solid #d9e2ec; border-radius: 8px; padding: 20px; }
  .card h2 { margin: 0 0 8px; font-size: 20px; }
  .price { font-size: 28px; font-weight: bold; color: #0b7285; }
  .button { display: inline-block; margin-top: 12px; padding: 10px 18px; border-radius: 6px;
            background: #0b7285; color: #fff; text-decoration: none; }
  footer { padding: 24px; text-align: center; color: #829ab1; font-size: 13px; }
`;

/** The layout bug introduced in version 2: fixed-width cards that overflow and overlap. */
const BROKEN_PRICING_STYLE = `
  .cards { flex-wrap: nowrap; }
  .card { flex: 0 0 420px; margin-right: -240px; }
`;

function layout(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Demo Shop</title>
<style>${STYLE}${extraStyle}</style></head>
<body>
<header><strong>Demo Shop</strong>
  <span><span id="live-clock"></span><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/blog">Blog</a></nav></span>
</header>
<main>${body}</main>
<footer>Demo Shop · pixelguard demo site</footer>
<script>
  // A live clock: different on every capture. Ignored via pixelguard.regions.json.
  document.getElementById("live-clock").textContent = new Date().toISOString().slice(11, 23);
</script>
</body></html>`;
}

function page(path: string, version: DemoVersion): string | null {
  switch (path) {
    case "/":
      return layout(
        "Home",
        `<h1>Welcome to Demo Shop</h1>
         <p>Hand-made goods, shipped anywhere in South Africa.</p>
         <p class="muted">Last updated: ${version === 1 ? "24 September 2026" : "25 September 2026"}</p>
         <a class="button" href="/pricing">See pricing</a>`
      );
    case "/pricing":
      return layout(
        "Pricing",
        `<h1>Pricing</h1>
         <div class="cards">
           <div class="card"><h2>Starter</h2><div class="price">R99</div><p>For trying things out.</p><a class="button" href="#">Choose</a></div>
           <div class="card"><h2>Pro</h2><div class="price">R249</div><p>For growing shops.</p><a class="button" href="#">Choose</a></div>
           <div class="card"><h2>Business</h2><div class="price">R599</div><p>For teams.</p><a class="button" href="#">Choose</a></div>
         </div>`,
        version === 2 ? BROKEN_PRICING_STYLE : ""
      );
    case "/blog":
      return layout(
        "Blog",
        `<h1>Blog</h1>
         <article><h2>How we package our goods</h2><p>Every order is wrapped by hand in recycled paper.</p></article>
         <article><h2>Opening our second workshop</h2><p>We're growing, and hiring in Johannesburg.</p></article>`
      );
    default:
      return null;
  }
}

export interface DemoSite {
  url: string;
  version: DemoVersion;
  setVersion(version: DemoVersion): void;
  close(): Promise<void>;
}

/** Starts the demo site on a free local port (or the given one). */
export async function startDemoSite(
  options: { version?: DemoVersion; port?: number } = {}
): Promise<DemoSite> {
  let version: DemoVersion = options.version ?? 1;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://demo");
    // ?version=1 or ?version=2 shows that version for one page view, so a
    // presenter can open "before" and "after" side by side (P049).
    const asked = url.searchParams.get("version");
    const shown: DemoVersion = asked === "1" ? 1 : asked === "2" ? 2 : version;
    const html = page(url.pathname, shown);
    if (html === null) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    get version() {
      return version;
    },
    setVersion(v) {
      version = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
