// Formatting helpers for the dashboard (pure functions, unit-tested).
// Ticket: P039

/** Status -> label and CSS modifier. */
export const STATUS = {
  // Same words as the run list's status filter.
  fail: { label: "Failing", mark: "✗" },
  review: { label: "Needs review", mark: "?" },
  pass: { label: "Passing", mark: "✓" },
};

/**
 * "25 Sep 2026, 10:43" in the viewer's local time zone.
 * @param {string} iso
 * @param {string} [locale]
 */
export function formatDate(iso, locale = undefined) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "just now", "5 min ago", "3 h ago", "2 days ago", or a date for older runs.
 * @param {string} iso
 * @param {Date} [now]
 */
export function relativeTime(iso, now = new Date()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(iso).split(",")[0];
}

/**
 * The run headline without its "FAIL: " prefix (the status badge shows that).
 * @param {string} headline
 */
export function headlineDetail(headline) {
  const match = /^(PASS|REVIEW|FAIL):\s*(.*)$/s.exec(headline);
  return match ? match[2] : headline;
}

/**
 * "https://shop.example.com/" -> "shop.example.com"; falls back to the input.
 * @param {string | null} url
 */
export function shortTarget(url) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/**
 * Page counts as short text, e.g. "1 fail · 2 review · 5 pass" (zeros left out).
 * @param {{ fail: number, review: number, pass: number }} pages
 */
export function pageCounts(pages) {
  const parts = [];
  if (pages.fail) parts.push(`${pages.fail} fail`);
  if (pages.review) parts.push(`${pages.review} review`);
  if (pages.pass) parts.push(`${pages.pass} pass`);
  return parts.length > 0 ? parts.join(" · ") : "no pages";
}

/**
 * Reads "#/runs?status=fail&page=2" into { path: "/runs", params }.
 * @param {string} hash
 */
export function parseHash(hash) {
  const raw = hash.replace(/^#/, "") || "/runs";
  const [path, query = ""] = raw.split("?");
  return { path: path || "/runs", params: new URLSearchParams(query) };
}

/**
 * Builds "#/runs?status=fail&page=2", leaving out empty values and page 1.
 * @param {string} path
 * @param {Record<string, string | number | undefined | null>} params
 */
export function buildHash(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "page" && Number(value) === 1) continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

/**
 * "5.00%", "<0.01%", "0%".
 * @param {number | null} percent
 */
export function formatPercent(percent) {
  if (percent === null || percent === undefined) return "—";
  if (percent === 0) return "0%";
  if (percent < 0.01) return "<0.01%";
  return `${percent.toFixed(2)}%`;
}

/**
 * 1234567 -> "1,234,567".
 * @param {number | null} n
 */
export function formatCount(n) {
  if (n === null || n === undefined) return "—";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * How one screenshot turned out, as a short label and a status class.
 * @param {{ compared: boolean, changed: boolean | null, verdict: string | null,
 *           confidence: number | null, judgeError: string | null, status: string }} shot
 */
export function screenshotLabel(shot) {
  if (!shot.compared) return { text: "Not compared", status: "review" };
  if (!shot.changed) return { text: "Unchanged", status: "pass" };
  if (shot.judgeError) return { text: "Couldn't be judged", status: "review" };
  if (shot.verdict) {
    const conf = shot.confidence ? ` (${shot.confidence}/10)` : "";
    return { text: `${shot.verdict}${conf}`, status: shot.status };
  }
  return { text: "Changed (not judged)", status: "review" };
}

/**
 * "height 2000px → 2300px", or "" if the size didn't change.
 * @param {{ sizeChanged: boolean | null, baselineSize: {width:number,height:number} | null,
 *           currentSize: {width:number,height:number} | null }} shot
 */
export function describeSizeChange(shot) {
  if (!shot.sizeChanged || !shot.baselineSize || !shot.currentSize) return "";
  const b = shot.baselineSize;
  const c = shot.currentSize;
  const parts = [];
  if (b.width !== c.width) parts.push(`width ${b.width}px → ${c.width}px`);
  if (b.height !== c.height) parts.push(`height ${b.height}px → ${c.height}px`);
  return parts.join(", ");
}
