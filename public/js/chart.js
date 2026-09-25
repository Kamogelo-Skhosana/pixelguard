// Pure helpers for the trend chart: scales, ticks, labels and bar layout.
// No DOM here, so it is unit-tested in Node. Ticket: P041

export const PERIODS = /** @type {const} */ (["day", "week", "run"]);
export const RANGES = /** @type {const} */ ([7, 30, 90, 365]);

/**
 * Parses and cleans the trend page's query params, falling back to defaults.
 * @param {URLSearchParams | Record<string, string>} params
 */
export function trendOptions(params) {
  const get = (/** @type {string} */ key) =>
    params instanceof URLSearchParams ? params.get(key) : params[key];
  const rawPeriod = get("period");
  const period = PERIODS.includes(/** @type {any} */ (rawPeriod)) ? rawPeriod : "day";
  const days = Number(get("days"));
  return {
    period: /** @type {"day" | "week" | "run"} */ (period),
    days: RANGES.includes(/** @type {any} */ (days)) ? days : 30,
  };
}

/**
 * Rounds a maximum up to a "nice" axis top (1, 2, 5, 10, 20, 50…), at least 1.
 * @param {number} max
 */
export function niceMax(max) {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Whole-number gridline values from 0 to top (inclusive), at most ~5 of them.
 * @param {number} top a value returned by niceMax
 */
export function axisTicks(top) {
  const step = Math.max(1, Math.ceil(top / 5));
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== top) ticks.push(top);
  return ticks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Short x-axis label for a trend point.
 * day "2026-09-25" → "25 Sep"; week → "w/c 21 Sep"; run → "#12".
 * @param {{ label: string, runId?: number }} point
 * @param {string} period
 */
export function pointLabel(point, period) {
  if (period === "run") return point.runId !== undefined ? `#${point.runId}` : point.label;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(point.label);
  if (!m) return point.label;
  const text = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return period === "week" ? `w/c ${text}` : text;
}

/**
 * One-line description of a point, used for the bar tooltip and screen readers.
 * @param {any} point a TrendPoint
 * @param {string} period
 */
export function describePoint(point, period) {
  const when =
    period === "run"
      ? `Run #${point.runId}`
      : period === "week"
        ? `Week of ${pointLabel(point, "day")}`
        : pointLabel(point, "day");
  if (point.runs === 0) return `${when}: no runs`;
  const parts = [`${point.pagesFailed} failing`, `${point.pagesReview} needs review`];
  if (point.realBugs > 0)
    parts.push(`${point.realBugs} real bug${point.realBugs === 1 ? "" : "s"}`);
  const runs = period === "run" ? "" : `, ${point.runs} run${point.runs === 1 ? "" : "s"}`;
  return `${when}: ${parts.join(", ")} of ${point.pagesChecked} pages${runs}`;
}

/**
 * Picks which x labels to show so they don't overlap: every nth point, plus
 * always the last one. Returns a Set of indexes.
 * @param {number} count number of points
 * @param {number} maxLabels how many labels fit
 */
export function labelIndexes(count, maxLabels) {
  const shown = new Set();
  if (count === 0) return shown;
  const every = Math.max(1, Math.ceil(count / Math.max(1, maxLabels)));
  for (let i = count - 1; i >= 0; i -= every) shown.add(i);
  return shown;
}

/**
 * Lays out stacked bars (failing at the bottom, needs review on top).
 * @param {any[]} points TrendPoints
 * @param {{ width: number, height: number }} size plot area in px
 */
export function layoutBars(points, size) {
  const max = points.reduce((m, p) => Math.max(m, p.pagesFailed + p.pagesReview), 0);
  const top = niceMax(max);
  const slot = points.length ? size.width / points.length : 0;
  const barWidth = Math.max(1, Math.min(40, slot * 0.7));
  const y = (/** @type {number} */ v) => size.height - (v / top) * size.height;
  const bars = points.map((p, i) => {
    const x = i * slot + (slot - barWidth) / 2;
    const failH = size.height - y(p.pagesFailed);
    const reviewH = size.height - y(p.pagesReview);
    return {
      index: i,
      x,
      width: barWidth,
      slotX: i * slot,
      slotWidth: slot,
      centre: i * slot + slot / 2,
      empty: p.runs === 0,
      fail: { y: size.height - failH, height: failH },
      review: { y: size.height - failH - reviewH, height: reviewH },
    };
  });
  return { top, ticks: axisTicks(top), y, bars };
}

/**
 * Formats a 0-1 rate as a percentage, or "–" when there's no data.
 * @param {number | null | undefined} rate
 */
export function formatRate(rate) {
  if (rate === null || rate === undefined) return "–";
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}
