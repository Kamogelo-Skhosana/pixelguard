// pixelguard dashboard: a tiny hash router. Ticket: P039

import { h } from "./dom.js";
import { parseHash } from "./format.js";
import { renderRunList } from "./pages/runList.js";

const root = /** @type {HTMLElement} */ (document.getElementById("app"));

function showError(err) {
  root.replaceChildren(
    h(
      "div",
      { class: "error", id: "error", role: "alert" },
      h("strong", {}, "Something went wrong. "),
      err?.message ?? String(err)
    ),
    h("p", {}, h("a", { href: "#/runs" }, "Back to runs"))
  );
}

async function route() {
  const { path, params } = parseHash(location.hash);
  document.body.dataset.route = path;
  try {
    if (path === "/runs") {
      await renderRunList(root, params);
    } else if (/^\/runs\/\d+$/.test(path)) {
      // Run detail page arrives in P040.
      root.replaceChildren(
        h("h1", {}, `Run ${path.split("/")[2]}`),
        h("p", { class: "muted" }, "The run detail view is coming soon."),
        h("p", {}, h("a", { href: "#/runs" }, "← Back to runs"))
      );
    } else {
      root.replaceChildren(
        h("h1", {}, "Page not found"),
        h("p", {}, h("a", { href: "#/runs" }, "Go to runs"))
      );
    }
  } catch (err) {
    showError(err);
  } finally {
    document.body.dataset.ready = "true";
  }
}

window.addEventListener("hashchange", () => {
  document.body.dataset.ready = "false";
  void route();
});
void route();
