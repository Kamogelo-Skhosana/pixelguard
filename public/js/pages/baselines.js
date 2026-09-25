// Baseline history: #/baselines/:tag and one version: #/baselines/:tag/v3  (P043)
// Uses GET /api/baselines/:tag/history, GET …/versions/:v and POST …/restore.

import { ApiError, fetchBaselineHistory, fetchBaselineVersion, restoreBaseline } from "../api.js";
import { confirmable } from "../actions.js";
import { h, setChildren } from "../dom.js";
import { formatDate, relativeTime } from "../format.js";
import { server } from "../server.js";

const enc = encodeURIComponent;
const historyHash = (tag) => `#/baselines/${enc(tag)}`;
const versionHash = (tag, version) => `#/baselines/${enc(tag)}/v${version}`;

/**
 * How a version was made, in words (same rules as `pixelguard baseline history`).
 * @param {any} v a history entry: { version, source }
 */
export function describeSource(v) {
  const source = v?.source;
  if (source?.type === "restore") return `Restored from version ${source.fromVersion}`;
  // The baseline that existed before the first accept is recorded as version 1.
  if (source?.type === "accept" && v.version === 1 && source.screenshots === 0) {
    return "Original baseline (from before the first accept)";
  }
  if (source?.type === "accept") {
    const what = source.pages?.length ? `pages ${source.pages.join(", ")}` : "all pages";
    const n = source.screenshots;
    return `Accepted from "${source.fromTag}" (${what}, ${n} screenshot${n === 1 ? "" : "s"})`;
  }
  return "Unknown";
}

function versionState(v) {
  if (v.current) return h("span", { class: "badge badge--pass" }, "Current");
  if (v.archived) return h("span", { class: "badge badge--neutral" }, "Archived");
  return h(
    "span",
    { class: "muted small", title: "Only the newest versions are kept" },
    "No longer kept"
  );
}

function restoreAction(tag, version, onDone) {
  return confirmable({
    id: `restore-v${version}`,
    label: "Restore",
    question: `Make version ${version} the "${tag}" baseline again? The current baseline is archived first, so this can be undone.`,
    confirmLabel: `Yes, restore version ${version}`,
    workingLabel: `Restoring version ${version}…`,
    action: () => restoreBaseline(tag, version),
    success: (r) =>
      h(
        "p",
        {},
        h("strong", {}, "Restored. "),
        `Version ${r.restored.fromVersion} is the "${r.restored.tag}" baseline again, saved as version ${r.restored.version}. `,
        h("a", { href: historyHash(r.restored.tag) }, "View the baseline history")
      ),
    onDone,
  });
}

function historyTable(history, onRestored) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "runs history", id: "history-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["Version", "Became the baseline", "How", "State", ""].map((t) =>
            h("th", { scope: "col" }, t)
          )
        )
      ),
      h(
        "tbody",
        {},
        ...history.versions.map((v) =>
          h(
            "tr",
            { "data-version": v.version, class: v.current ? "is-current" : "" },
            h(
              "td",
              { class: "num" },
              v.current || v.archived
                ? h("a", { href: versionHash(history.tag, v.version) }, `v${v.version}`)
                : `v${v.version}`
            ),
            h(
              "td",
              {},
              h("time", { datetime: v.createdAt }, relativeTime(v.createdAt)),
              h("div", { class: "muted small" }, formatDate(v.createdAt))
            ),
            h("td", {}, describeSource(v)),
            h("td", {}, versionState(v)),
            h(
              "td",
              { class: "row-actions" },
              !v.current && v.archived && !server.readOnly
                ? restoreAction(history.tag, v.version, onRestored)
                : null
            )
          )
        )
      )
    )
  );
}

/**
 * @param {HTMLElement} root
 * @param {string} tag
 * @param {{ signal?: AbortSignal }} [ctx]
 */
export async function renderBaselines(root, tag, ctx) {
  root.replaceChildren(h("p", { class: "muted", id: "loading" }, "Loading baseline history…"));
  const history = await fetchBaselineHistory(tag, { signal: ctx?.signal });

  const heading = h("h1", {}, "Baseline history");
  const intro = h(
    "p",
    { class: "muted", id: "history-intro" },
    `Every version of the "${history.tag}" baseline, newest first. A new version is saved each time changes are accepted or an old version is restored.`,
    server.readOnly
      ? ` This dashboard is read-only; restore a version with: pixelguard baseline restore <version> --tag ${history.tag}`
      : null
  );

  if (history.versions.length === 0) {
    root.replaceChildren(
      heading,
      intro,
      h(
        "div",
        { class: "empty", id: "history-empty" },
        h("p", {}, `No history for "${history.tag}" yet.`),
        h(
          "p",
          { class: "muted" },
          "Accept changes from a run (or run `pixelguard accept --from current`) to start one."
        )
      )
    );
    return;
  }

  // After a restore: move the success message above the table, then redraw
  // the table so every version's state is up to date.
  const notice = h("div", { class: "notice-slot", id: "notice" });
  const tableSlot = h("div", {});
  const onRestored = async (_result, box) => {
    notice.replaceChildren(box);
    const fresh = await fetchBaselineHistory(tag).catch(() => null);
    if (fresh) tableSlot.replaceChildren(historyTable(fresh, onRestored));
  };
  tableSlot.replaceChildren(historyTable(history, onRestored));
  root.replaceChildren(heading, intro, notice, tableSlot);
}

/**
 * @param {HTMLElement} root
 * @param {string} tag
 * @param {number} version
 * @param {{ signal?: AbortSignal }} [ctx]
 * @param {Node | null} [notice] a message to show at the top (after a restore)
 */
export async function renderBaselineVersion(root, tag, version, ctx, notice = null) {
  root.replaceChildren(h("p", { class: "muted", id: "loading" }, `Loading version ${version}…`));
  let detail;
  let history;
  try {
    [detail, history] = await Promise.all([
      fetchBaselineVersion(tag, version, { signal: ctx?.signal }),
      fetchBaselineHistory(tag, { signal: ctx?.signal }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      root.replaceChildren(
        h("h1", {}, "Version not available"),
        h("p", { id: "not-found" }, err.message),
        h("p", {}, h("a", { href: historyHash(tag) }, "← Baseline history"))
      );
      return;
    }
    throw err;
  }

  const entry = history.versions.find((v) => v.version === version);
  const back = h("p", {}, h("a", { href: historyHash(tag) }, "← Baseline history"));
  const title = h(
    "h1",
    {},
    `"${detail.tag}" version ${detail.version} `,
    entry ? versionState(entry) : null
  );
  const meta = h(
    "div",
    { class: "meta" },
    h("span", {}, h("strong", {}, "Captured: "), formatDate(detail.capturedAt)),
    detail.baseUrl ? h("span", {}, h("strong", {}, "Site: "), detail.baseUrl) : null,
    entry ? h("span", {}, h("strong", {}, "How: "), describeSource(entry)) : null
  );
  const actions =
    entry && !entry.current && entry.archived && !server.readOnly
      ? h(
          "div",
          { class: "accept-panel" },
          // Redraw so the page shows this version as current, keeping the message.
          restoreAction(tag, version, (_result, box) => {
            // Only if the user is still on this page.
            if (location.hash !== versionHash(tag, version)) return;
            renderBaselineVersion(root, tag, version, undefined, box).catch(() => {});
          })
        )
      : null;

  const pages = detail.pages.map((p) =>
    h(
      "section",
      { class: "page version-page", "data-page": p.name },
      h("h2", { class: "page-name" }, p.page),
      p.screenshots.length === 0
        ? h("p", { class: "muted small" }, "No screenshots.")
        : h(
            "div",
            { class: "images" },
            ...p.screenshots.map((s) =>
              h(
                "figure",
                { class: "shot-image" },
                h("figcaption", {}, s.viewport),
                h(
                  "a",
                  { href: s.image, target: "_blank", rel: "noopener" },
                  h("img", { src: s.image, alt: `${p.page} ${s.viewport}`, loading: "lazy" })
                )
              )
            )
          )
    )
  );

  setChildren(
    root,
    back,
    notice,
    title,
    meta,
    actions,
    pages.length > 0
      ? h("div", { class: "pages", id: "version-pages" }, ...pages)
      : h("div", { class: "empty" }, "This version has no pages.")
  );
}
