// Trend page: #/trend?period=day&days=30  (P041)
// Stacked bars of failing and needs-review pages over time, from GET /api/runs/trend.

import { fetchTrend } from "../api.js";
import {
  describePoint,
  formatRate,
  labelIndexes,
  layoutBars,
  pointLabel,
  RANGES,
  trendOptions,
} from "../chart.js";
import { h, svg } from "../dom.js";
import { buildHash } from "../format.js";

// Drawing size in SVG units; the SVG scales to its container's width.
const WIDTH = 880;
const HEIGHT = 280;
const MARGIN = { top: 16, right: 12, bottom: 32, left: 40 };
const PLOT = {
  width: WIDTH - MARGIN.left - MARGIN.right,
  height: HEIGHT - MARGIN.top - MARGIN.bottom,
};

const PERIOD_LABELS = { day: "Daily", week: "Weekly", run: "Per run" };

function controls(options) {
  const go = (change) => {
    location.hash = buildHash("/trend", { ...options, ...change });
  };
  const period = h(
    "select",
    { id: "trend-period", onchange: (e) => go({ period: e.target.value }) },
    ...Object.entries(PERIOD_LABELS).map(([value, label]) => h("option", { value }, label))
  );
  period.value = options.period;
  const range = h(
    "select",
    { id: "trend-days", onchange: (e) => go({ days: e.target.value }) },
    ...RANGES.map((d) => h("option", { value: d }, d === 365 ? "Last year" : `Last ${d} days`))
  );
  range.value = String(options.days);
  return h(
    "div",
    { class: "toolbar trend-controls" },
    h("label", { for: "trend-period" }, "Group "),
    period,
    h("label", { for: "trend-days" }, " Range "),
    range
  );
}

function tile(id, label, value, note) {
  return h(
    "div",
    { class: "tile", id },
    h("div", { class: "tile-value" }, value),
    h("div", { class: "tile-label" }, label),
    note ? h("div", { class: "muted small" }, note) : null
  );
}

function summary(totals) {
  return h(
    "div",
    { class: "tiles", id: "trend-totals" },
    tile("tile-runs", "Runs", totals.runs, `${totals.failedRuns} failed`),
    tile("tile-failing", "Pages failing", totals.pagesFailed, `of ${totals.pagesChecked} checked`),
    tile("tile-review", "Needs review", totals.pagesReview),
    tile("tile-bugs", "Real bugs", totals.realBugs),
    tile("tile-rate", "Regression rate", formatRate(totals.regressionRate), "pages failing")
  );
}

function chart(trend) {
  const { period, points } = trend;
  const layout = layoutBars(points, PLOT);
  const readout = h("p", { class: "chart-readout muted small", id: "chart-readout" }, " ");
  const show = (point) => {
    readout.textContent = point ? describePoint(point, period) : " ";
  };

  const grid = layout.ticks.map((t) =>
    svg(
      "g",
      { className: "gridline" },
      svg("line", { x1: 0, x2: PLOT.width, y1: layout.y(t), y2: layout.y(t) }),
      svg("text", { x: -8, y: layout.y(t), dy: "0.32em", "text-anchor": "end" }, t)
    )
  );

  const labels = labelIndexes(points.length, Math.floor(PLOT.width / 64));
  const bars = layout.bars.map((bar) => {
    const point = points[bar.index];
    const text = describePoint(point, period);
    const link = period === "run" && point.runId !== undefined;
    const open = () => {
      if (link) location.hash = `#/runs/${point.runId}`;
    };
    return svg(
      "g",
      {
        className: `bar${bar.empty ? " bar--empty" : ""}${link ? " bar--link" : ""}`,
        "data-label": point.label,
        tabindex: 0,
        role: link ? "link" : "img",
        "aria-label": text,
        onmouseenter: () => show(point),
        onfocus: () => show(point),
        onmouseleave: () => show(null),
        onblur: () => show(null),
        onclick: open,
        onkeydown: (e) => {
          if (e.key === "Enter") open();
        },
      },
      svg("title", {}, text),
      // Invisible full-height hit area, so thin or empty bars are easy to hover.
      svg("rect", {
        className: "hit",
        x: bar.slotX,
        y: 0,
        width: bar.slotWidth,
        height: PLOT.height,
      }),
      bar.fail.height > 0
        ? svg("rect", {
            className: "seg seg--fail",
            x: bar.x,
            y: bar.fail.y,
            width: bar.width,
            height: bar.fail.height,
          })
        : null,
      bar.review.height > 0
        ? svg("rect", {
            className: "seg seg--review",
            x: bar.x,
            y: bar.review.y,
            width: bar.width,
            height: bar.review.height,
          })
        : null,
      // Runs that found nothing wrong get a small green baseline mark, so
      // "ran and passed" looks different from "didn't run".
      !bar.empty && bar.fail.height + bar.review.height === 0
        ? svg("rect", {
            className: "seg seg--pass",
            x: bar.x,
            y: PLOT.height - 3,
            width: bar.width,
            height: 3,
          })
        : null,
      point.realBugs > 0
        ? svg("circle", {
            className: "bug-marker",
            cx: bar.centre,
            cy: Math.min(bar.review.y, bar.fail.y) - 7,
            r: 4,
          })
        : null,
      labels.has(bar.index)
        ? svg(
            "text",
            { className: "x-label", x: bar.centre, y: PLOT.height + 20, "text-anchor": "middle" },
            pointLabel(point, period)
          )
        : null
    );
  });

  const figure = svg(
    "svg",
    {
      id: "trend-chart",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: "group",
      "aria-label": `Failing and needs-review pages, ${PERIOD_LABELS[period].toLowerCase()}, ${trend.from} to ${trend.to}`,
    },
    svg(
      "g",
      { transform: `translate(${MARGIN.left},${MARGIN.top})` },
      ...grid,
      svg("line", { className: "axis", x1: 0, x2: PLOT.width, y1: PLOT.height, y2: PLOT.height }),
      ...bars
    )
  );

  return h(
    "figure",
    { class: "chart" },
    // Scrolls sideways on small screens rather than shrinking the text.
    h("div", { class: "chart-scroll" }, figure),
    readout,
    h(
      "figcaption",
      { class: "legend small" },
      h("span", { class: "key key--fail" }, "Failing pages"),
      h("span", { class: "key key--review" }, "Needs review"),
      h("span", { class: "key key--pass" }, "Ran, all passed"),
      h("span", { class: "key key--bug" }, "Real bug found"),
      period === "run" ? h("span", { class: "muted" }, "Click a bar to open the run.") : null
    )
  );
}

function dataTable(trend) {
  const { period, points } = trend;
  const rows = points.filter((p) => p.runs > 0);
  return h(
    "details",
    { class: "trend-table", id: "trend-table" },
    h("summary", {}, "Show data as a table"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "runs" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...[
              period === "run" ? "Run" : "Period",
              "Runs",
              "Pages",
              "Failing",
              "Needs review",
              "Real bugs",
              "Regression rate",
            ].map((c) => h("th", {}, c))
          )
        ),
        h(
          "tbody",
          {},
          ...rows.map((p) =>
            h(
              "tr",
              {},
              h(
                "td",
                {},
                period === "run"
                  ? h("a", { href: `#/runs/${p.runId}` }, pointLabel(p, period))
                  : pointLabel(p, period)
              ),
              h("td", { class: "num" }, p.runs),
              h("td", { class: "num" }, p.pagesChecked),
              h("td", { class: "num" }, p.pagesFailed),
              h("td", { class: "num" }, p.pagesReview),
              h("td", { class: "num" }, p.realBugs),
              h("td", { class: "num" }, formatRate(p.regressionRate))
            )
          )
        )
      )
    )
  );
}

/**
 * @param {HTMLElement} root
 * @param {URLSearchParams} params
 * @param {{ signal?: AbortSignal }} [ctx] cancelled when the user navigates away
 */
export async function renderTrend(root, params, ctx) {
  const options = trendOptions(params);
  const trend = await fetchTrend(options, { signal: ctx?.signal });
  const heading = h("h1", {}, "Regressions over time");
  const range = h("p", { class: "muted", id: "trend-range" }, `${trend.from} to ${trend.to} (UTC)`);

  if (trend.totals.runs === 0) {
    root.replaceChildren(
      heading,
      controls(options),
      range,
      h(
        "div",
        { class: "empty", id: "trend-empty" },
        h("p", {}, `No runs in the last ${options.days} days.`),
        h(
          "p",
          { class: "muted" },
          "Runs appear here after `pixelguard diff` saves them. Try a longer range."
        )
      )
    );
    return;
  }

  root.replaceChildren(
    heading,
    controls(options),
    range,
    summary(trend.totals),
    chart(trend),
    dataTable(trend)
  );
  // On narrow screens the chart scrolls; start at the newest end.
  const scroller = root.querySelector(".chart-scroll");
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
}
