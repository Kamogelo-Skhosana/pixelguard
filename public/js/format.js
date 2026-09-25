// Formatting helpers for the dashboard (pure functions, unit-tested).
// Ticket: P039

/** Status -> label and CSS modifier. */
export const STATUS = {
  fail: { label: "FAIL", mark: "✗" },
  review: { label: "REVIEW", mark: "?" },
  pass: { label: "PASS", mark: "✓" },
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
