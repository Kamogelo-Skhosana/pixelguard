// pixelguard dashboard: a tiny hash router. Tickets: P039, P043
//
// Each route gets an AbortSignal. Navigating again cancels the previous
// route's requests, so a slow response can never draw over a newer page.

import { isAbort } from "./api.js";
import { h } from "./dom.js";
import { parseHash } from "./format.js";
import { renderBaselines, renderBaselineVersion } from "./pages/baselines.js";
import { renderRunDetail } from "./pages/runDetail.js";
import { renderRunList } from "./pages/runList.js";
import { renderTrend } from "./pages/trend.js";
import { loadServerInfo } from "./server.js";

const root = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @type {AbortController | null} */
let active = null;

function showError(err) {
  root.replaceChildren(
    h(
      "div",
      { class: "error", id: "error", role: "alert" },
      h("strong", {}, "Something went wrong. "),
      err?.message ?? String(err),
      Array.isArray(err?.issues) && err.issues.length > 0
        ? h("ul", {}, ...err.issues.map((i) => h("li", {}, i)))
        : null
    ),
    h(
      "p",
      {},
      h(
        "button",
        { type: "button", class: "button", id: "retry", onclick: () => route() },
        "Try again"
      ),
      " ",
      h("a", { href: "#/runs" }, "Back to runs")
    )
  );
}

/** Marks the top-bar link for the current section. */
function highlightNav(path) {
  for (const link of document.querySelectorAll(".topbar nav a")) {
    const section = link.getAttribute("href")?.replace(/^#/, "") ?? "";
    if (path === section || path.startsWith(`${section}/`)) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

/**
 * Finds the page for a path. Returns null for unknown paths.
 * @param {string} path
 * @param {URLSearchParams} params
 * @returns {((ctx: { signal: AbortSignal }) => Promise<void>) | null}
 */
function resolve(path, params) {
  if (path === "/runs") return (ctx) => renderRunList(root, params, ctx);
  if (path === "/trend") return (ctx) => renderTrend(root, params, ctx);
  let m = /^\/runs\/(\d+)$/.exec(path);
  if (m) return (ctx) => renderRunDetail(root, Number(m[1]), ctx);
  if (path === "/baselines") return (ctx) => renderBaselines(root, "baseline", ctx);
  m = /^\/baselines\/([^/]+)$/.exec(path);
  if (m) return (ctx) => renderBaselines(root, decodeURIComponent(m[1]), ctx);
  m = /^\/baselines\/([^/]+)\/v(\d+)$/.exec(path);
  if (m) return (ctx) => renderBaselineVersion(root, decodeURIComponent(m[1]), Number(m[2]), ctx);
  return null;
}

async function route() {
  active?.abort();
  const controller = new AbortController();
  active = controller;

  const { path, params } = parseHash(location.hash);
  document.body.dataset.route = path;
  window.scrollTo(0, 0);
  highlightNav(path);
  try {
    const render = resolve(path, params);
    if (render) {
      await render({ signal: controller.signal });
    } else {
      root.replaceChildren(
        h("h1", {}, "Page not found"),
        h("p", {}, h("a", { href: "#/runs" }, "Go to runs"))
      );
    }
  } catch (err) {
    // Cancelled because the user moved on: the newer route draws the page.
    if (controller.signal.aborted || isAbort(err)) return;
    showError(err);
  }
  if (controller.signal.aborted) return;
  document.body.dataset.ready = "true";
  // Counts finished renders, so tests can wait for "the next render" without races.
  document.body.dataset.renders = String(Number(document.body.dataset.renders ?? "0") + 1);
}

window.addEventListener("hashchange", () => {
  document.body.dataset.ready = "false";
  void route();
});
// Learn whether the server is read-only before drawing the first page.
void loadServerInfo().then(route);
