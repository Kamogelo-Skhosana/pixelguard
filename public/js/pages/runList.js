// Run list page: #/runs?status=fail&page=2  (P039)

import { fetchRuns } from "../api.js";
import { h } from "../dom.js";
import {
  buildHash,
  formatDate,
  headlineDetail,
  pageCounts,
  relativeTime,
  shortTarget,
  STATUS,
} from "../format.js";

export const PAGE_SIZE = 25;

function statusBadge(status) {
  const s = STATUS[status] ?? { label: status, mark: "" };
  return h("span", { class: `badge badge--${status}` }, `${s.mark} ${s.label}`);
}

function filters(current) {
  const select = h(
    "select",
    {
      id: "status-filter",
      "aria-label": "Filter by status",
      onchange: (e) => {
        location.hash = buildHash("/runs", { status: e.target.value });
      },
    },
    h("option", { value: "" }, "All statuses"),
    h("option", { value: "fail" }, "Failing"),
    h("option", { value: "review" }, "Needs review"),
    h("option", { value: "pass" }, "Passing")
  );
  select.value = current ?? "";
  return h("div", { class: "toolbar" }, h("label", { for: "status-filter" }, "Show "), select);
}

function row(run) {
  const open = () => {
    location.hash = `#/runs/${run.id}`;
  };
  return h(
    "tr",
    {
      class: "run-row",
      "data-run-id": run.id,
      tabindex: 0,
      onclick: open,
      onkeydown: (e) => {
        if (e.key === "Enter") open();
      },
    },
    h("td", { class: "num" }, h("a", { href: `#/runs/${run.id}` }, `#${run.id}`)),
    h(
      "td",
      {},
      h(
        "time",
        { datetime: run.createdAt, title: formatDate(run.createdAt) },
        relativeTime(run.createdAt)
      ),
      h("div", { class: "muted small" }, formatDate(run.createdAt))
    ),
    h("td", { title: run.targetUrl ?? "" }, shortTarget(run.targetUrl)),
    h("td", { class: "mono small" }, `${run.baselineTag} → ${run.currentTag}`),
    h("td", {}, statusBadge(run.status)),
    h(
      "td",
      { class: "summary" },
      headlineDetail(run.headline),
      run.changeDescription
        ? h("div", { class: "muted small note" }, `“${run.changeDescription}”`)
        : null
    ),
    h("td", { class: "small" }, pageCounts(run.pages)),
    h("td", { class: "small muted" }, run.judged ? run.judgeModel : "not judged")
  );
}

function pager(list, page, status) {
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const first = list.total === 0 ? 0 : list.offset + 1;
  const last = list.offset + list.runs.length;
  return h(
    "nav",
    { class: "pager", "aria-label": "Pages" },
    h(
      "a",
      {
        class: "button",
        href: buildHash("/runs", { status, page: page - 1 }),
        "aria-disabled": page <= 1 ? "true" : null,
      },
      "← Newer"
    ),
    h(
      "span",
      { class: "muted small", id: "page-info" },
      `${first}–${last} of ${list.total} runs · page ${page} of ${pages}`
    ),
    h(
      "a",
      {
        class: "button",
        href: buildHash("/runs", { status, page: page + 1 }),
        "aria-disabled": page >= pages ? "true" : null,
      },
      "Older →"
    )
  );
}

/**
 * Renders the run list into `root`.
 * @param {HTMLElement} root
 * @param {URLSearchParams} params
 */
export async function renderRunList(root, params) {
  const status = ["fail", "review", "pass"].includes(params.get("status") ?? "")
    ? params.get("status")
    : "";
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);

  root.replaceChildren(
    h("h1", {}, "Runs"),
    filters(status),
    h("p", { class: "muted", id: "loading" }, "Loading runs…")
  );

  const list = await fetchRuns({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, status });

  const content =
    list.total === 0
      ? h(
          "div",
          { class: "empty", id: "empty" },
          status
            ? h("p", {}, "No runs match this filter.")
            : [
                h("p", {}, "No runs yet."),
                h(
                  "p",
                  { class: "muted" },
                  "Runs appear here after you run ",
                  h("code", {}, "pixelguard diff"),
                  "."
                ),
              ]
        )
      : h(
          "div",
          {},
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "runs", id: "runs-table" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  ...[
                    "Run",
                    "When",
                    "Target",
                    "Compared",
                    "Status",
                    "Summary",
                    "Pages",
                    "Judge",
                  ].map((t) => h("th", { scope: "col" }, t))
                )
              ),
              h("tbody", {}, ...list.runs.map(row))
            )
          ),
          pager(list, page, status)
        );

  root.replaceChildren(h("h1", {}, "Runs"), filters(status), content);
}
