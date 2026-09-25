// pixelguard dashboard: a tiny hash router. Ticket: P039

import { h } from "./dom.js";
import { parseHash } from "./format.js";
import { renderRunDetail } from "./pages/runDetail.js";
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
  window.scrollTo(0, 0);
  try {
    if (path === "/runs") {
      await renderRunList(root, params);
    } else if (/^\/runs\/\d+$/.test(path)) {
      await renderRunDetail(root, Number(path.split("/")[2]));
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
    // Counts finished renders, so tests can wait for "the next render" without races.
    document.body.dataset.renders = String(Number(document.body.dataset.renders ?? "0") + 1);
  }
}

window.addEventListener("hashchange", () => {
  document.body.dataset.ready = "false";
  void route();
});
void route();
