// Run detail page: #/runs/:id — every page of a run with a side-by-side
// baseline / current / diff viewer for each changed screenshot. (P040)

import { acceptRun, ApiError, fetchRun } from "../api.js";
import { confirmable } from "../actions.js";
import { h, setChildren } from "../dom.js";
import { server } from "../server.js";
import {
  describeSizeChange,
  formatCount,
  formatDate,
  formatPercent,
  headlineDetail,
  pageCounts,
  relativeTime,
  screenshotLabel,
  STATUS,
} from "../format.js";

const RANK = { fail: 0, review: 1, pass: 2 };

function badge(status, text) {
  const s = STATUS[status] ?? { mark: "", label: status };
  return h("span", { class: `badge badge--${status}` }, text ?? `${s.mark} ${s.label}`);
}

/** An image that links to its full-size version, with a placeholder if it's gone. */
function image(src, label, alt) {
  if (!src) {
    return h(
      "figure",
      { class: "shot-image" },
      h("figcaption", {}, label),
      h("div", { class: "missing" }, "No image")
    );
  }
  const img = h("img", { src, alt, loading: "lazy" });
  const figure = h(
    "figure",
    { class: "shot-image" },
    h("figcaption", {}, label),
    h(
      "a",
      {
        href: src,
        target: "_blank",
        rel: "noopener",
        title: `Open the ${label.toLowerCase()} image full size`,
      },
      img
    )
  );
  // Screenshots can be cleaned up after a run; say so instead of a broken icon.
  img.addEventListener("error", () => {
    figure.replaceChildren(
      h("figcaption", {}, label),
      h(
        "div",
        { class: "missing" },
        "This image is no longer available (the screenshots may have been cleaned up)."
      )
    );
  });
  return figure;
}

function screenshotCard(page, shot) {
  const label = screenshotLabel(shot);
  const facts = [];
  if (shot.compared && shot.changed) {
    facts.push(
      h(
        "li",
        {},
        h("strong", {}, "Changed: "),
        `${formatPercent(shot.percentChanged)} of the page (${formatCount(shot.pixelDiffCount)} pixels)`
      )
    );
  }
  const size = describeSizeChange(shot);
  if (size) facts.push(h("li", {}, h("strong", {}, "Page size: "), size));
  const ignored = [...new Set(shot.ignoredRegions.map((r) => r.label))];
  if (ignored.length > 0)
    facts.push(h("li", {}, h("strong", {}, "Ignored regions: "), ignored.join(", ")));
  const expected = [...new Set(shot.expectedChangeRegions.map((r) => r.label))];
  if (expected.length > 0)
    facts.push(h("li", {}, h("strong", {}, "Expected to change: "), expected.join(", ")));
  if (!shot.compared) facts.push(h("li", {}, shot.skipReason ?? "Not compared"));

  const explanation = shot.judgeError ?? (shot.verdict ? shot.explanation : null);

  return h(
    "article",
    {
      class: `shot shot--${label.status}`,
      "data-viewport": shot.viewport,
      id: `shot-${page.page}-${shot.viewport}`,
    },
    h(
      "header",
      { class: "shot-header" },
      h("h3", {}, shot.viewport),
      badge(label.status, label.text)
    ),
    facts.length > 0 ? h("ul", { class: "facts" }, ...facts) : null,
    explanation ? h("blockquote", { class: "explanation" }, explanation) : null,
    shot.observedChanges.length > 0
      ? h(
          "div",
          { class: "observed" },
          h("strong", {}, "What the judge saw:"),
          h("ul", {}, ...shot.observedChanges.map((c) => h("li", {}, c)))
        )
      : null,
    shot.compared
      ? h(
          "div",
          { class: "images" },
          image(shot.images.baseline, "Baseline", `${page.page} ${shot.viewport} baseline`),
          image(shot.images.current, "Current", `${page.page} ${shot.viewport} current`),
          image(shot.images.diff, "Diff", `${page.page} ${shot.viewport} diff`)
        )
      : null
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** When some screenshots failed, offers to accept just the ones that worked. */
function forceOffer(err) {
  if (err instanceof ApiError && err.code === "failed_screenshots") {
    return {
      label: "Accept the screenshots that worked",
      options: { force: true },
      note: "Screenshots that failed are left out; the baseline keeps its old ones for those.",
    };
  }
  return null;
}

/** "Accepted 4 screenshots … as version 3." with a link to the history. */
function acceptedMessage(accepted) {
  return [
    h(
      "p",
      {},
      h("strong", {}, "Accepted. "),
      `${plural(accepted.screenshots, "screenshot")} from "${accepted.fromTag}" `,
      accepted.wholeCapture ? "are " : `(${accepted.pages.join(", ")}) are `,
      `now the "${accepted.toTag}" baseline (version ${accepted.version}). `,
      "Run pixelguard diff again to compare against it."
    ),
    h(
      "p",
      {},
      h(
        "a",
        { href: `#/baselines/${encodeURIComponent(accepted.toTag)}` },
        "View the baseline history"
      ),
      " (the previous baseline can be restored from there)."
    ),
  ];
}

/** The "accept this page" control at the bottom of a changed page. */
function pageAccept(run, page) {
  return h(
    "div",
    { class: "page-actions" },
    confirmable({
      id: `accept-page-${page.page}`,
      label: "Accept this page",
      question: `Make the "${run.currentTag}" screenshots of ${page.page} the new "${run.baselineTag}" for this page? Other pages keep their current baseline.`,
      confirmLabel: "Yes, accept this page",
      workingLabel: `Accepting ${page.page}…`,
      action: (options) => acceptRun(run.id, { pages: [page.page], ...options }),
      success: (r) => acceptedMessage(r.accepted),
      fallback: forceOffer,
    })
  );
}

/** What a read-only dashboard shows instead of the accept buttons (P047). */
function readOnlyNote(run) {
  return h(
    "section",
    { class: "accept-panel accept-panel--read-only", id: "read-only-note" },
    h("h2", {}, "Accept these changes"),
    h(
      "p",
      {},
      "This dashboard is read-only. If these changes are intended, accept them from the command line:"
    ),
    h(
      "pre",
      {},
      h("code", {}, `pixelguard accept --from ${run.currentTag} --to ${run.baselineTag}`)
    )
  );
}

/** Panel for accepting the whole run, shown when something changed. */
function acceptPanel(run) {
  return h(
    "section",
    { class: "accept-panel", id: "accept" },
    h("h2", {}, "Accept these changes"),
    h(
      "p",
      {},
      `If these changes are what you intended, make the "${run.currentTag}" screenshots from this run the new "${run.baselineTag}". `,
      "Future runs will compare against them. The old baseline is kept in its history, so you can restore it."
    ),
    confirmable({
      id: "accept-all",
      label: "Accept all pages",
      primary: true,
      question: `Replace the whole "${run.baselineTag}" baseline with every page from "${run.currentTag}"?`,
      confirmLabel: "Yes, accept all pages",
      workingLabel: "Accepting all pages…",
      action: (options) => acceptRun(run.id, options),
      success: (r) => acceptedMessage(r.accepted),
      fallback: forceOffer,
    }),
    h(
      "p",
      { class: "muted small" },
      "To accept only some pages, use the button at the bottom of each changed page."
    )
  );
}

function pageSection(page, run) {
  // Changed and not-compared screenshots get a card (worst first); unchanged ones are listed.
  const cards = page.screenshots
    .filter((s) => !s.compared || s.changed)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
  const unchanged = page.screenshots.filter((s) => s.compared && !s.changed).map((s) => s.viewport);

  return h(
    "details",
    { class: `page page--${page.status}`, "data-page": page.page, open: page.status !== "pass" },
    h(
      "summary",
      {},
      h("span", { class: "page-name" }, page.page),
      badge(page.status),
      h("span", { class: "muted small page-summary" }, page.summary)
    ),
    ...cards.map((shot) => screenshotCard(page, shot)),
    unchanged.length > 0
      ? h("p", { class: "muted small unchanged" }, `Unchanged: ${unchanged.join(", ")}.`)
      : null,
    page.status !== "pass" && !server.readOnly ? pageAccept(run, page) : null
  );
}

function runHeader(run) {
  const meta = [
    run.targetUrl ? h("span", {}, h("strong", {}, "Target: "), run.targetUrl) : null,
    h(
      "span",
      {},
      h("strong", {}, "Compared: "),
      h("code", {}, run.baselineTag),
      " → ",
      h("code", {}, run.currentTag)
    ),
    h(
      "span",
      {},
      h("strong", {}, "When: "),
      `${formatDate(run.createdAt)} (${relativeTime(run.createdAt)})`
    ),
    h("span", {}, h("strong", {}, "Judge: "), run.judged ? run.judgeModel : "not judged"),
  ];
  return h(
    "section",
    { class: "run-header" },
    h("p", {}, h("a", { href: "#/runs" }, "← All runs")),
    h("h1", {}, `Run #${run.id} `, badge(run.status)),
    h("p", { class: "headline", id: "run-headline" }, headlineDetail(run.headline)),
    h("div", { class: "meta" }, ...meta),
    run.changeDescription
      ? h(
          "blockquote",
          { class: "change-note" },
          h("strong", {}, "What changed in this build: "),
          run.changeDescription
        )
      : null,
    h("p", { class: "muted small" }, `Pages: ${pageCounts(run.pages)}`)
  );
}

/**
 * Renders the run detail page into `root`.
 * @param {HTMLElement} root
 * @param {number} id
 * @param {{ signal?: AbortSignal }} [ctx] cancelled when the user navigates away
 */
export async function renderRunDetail(root, id, ctx) {
  root.replaceChildren(h("p", { class: "muted", id: "loading" }, `Loading run #${id}…`));
  let detail;
  try {
    detail = await fetchRun(id, { signal: ctx?.signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      root.replaceChildren(
        h("h1", {}, "Run not found"),
        h("p", { id: "not-found" }, `There's no run #${id}. It may have been deleted.`),
        h("p", {}, h("a", { href: "#/runs" }, "← All runs"))
      );
      return;
    }
    throw err;
  }

  const pages = [...detail.pages].sort((a, b) => RANK[a.status] - RANK[b.status]);
  const run = detail.run;
  setChildren(
    root,
    runHeader(run),
    // Nothing to accept when every page passed.
    pages.some((p) => p.status !== "pass")
      ? server.readOnly
        ? readOnlyNote(run)
        : acceptPanel(run)
      : null,
    pages.length > 0
      ? h("section", { class: "pages", id: "pages" }, ...pages.map((p) => pageSection(p, run)))
      : h("div", { class: "empty" }, "This run didn't compare any pages.")
  );
}
