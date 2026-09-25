// Client for the dashboard API. Tickets: P039 (reads), P043 (actions, robustness)
//
// Every call:
//  - turns HTTP, network and timeout failures into an ApiError with a message
//    that can be shown to the user as-is;
//  - can be cancelled with an AbortSignal (the router cancels a page's requests
//    when you navigate away, so a slow response can't overwrite the new page);
//  - GETs are retried once after a network error or a 502/503/504, since
//    reading is always safe to repeat. Actions (POST) are never retried.

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 when the server couldn't be reached
   * @param {string[]} [issues] validation problems from a 400 response
   * @param {string | null} [code] machine-readable reason, e.g. "failed_screenshots"
   */
  constructor(message, status, issues = [], code = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
    this.code = code;
  }
}

/** True for errors caused by our own cancellation (not worth showing). */
export function isAbort(err) {
  return err instanceof DOMException && err.name === "AbortError";
}

export const GET_TIMEOUT_MS = 20_000;
// Accepting copies screenshots on disk, which can take a while for big captures.
export const POST_TIMEOUT_MS = 120_000;
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 400;

const UNREACHABLE = "Can't reach the pixelguard server. Is `pixelguard dashboard` still running?";

/**
 * Low-level request. Resolves with the parsed JSON body (or null).
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, signal?: AbortSignal, timeoutMs?: number, retries?: number }} [options]
 */
export async function request(method, path, options = {}) {
  const { body, signal } = options;
  const timeoutMs = options.timeoutMs ?? (method === "GET" ? GET_TIMEOUT_MS : POST_TIMEOUT_MS);
  const retries = options.retries ?? (method === "GET" ? 1 : 0);

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const onAbort = () => timeout.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
        credentials: "same-origin",
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (timeout.signal.aborted) {
        throw new ApiError(
          `The server took too long to answer (over ${Math.max(1, Math.round(timeoutMs / 1000))}s). Try again.`,
          0
        );
      }
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      throw new ApiError(UNREACHABLE, 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (RETRY_STATUSES.has(res.status) && attempt < retries) {
      await sleep(RETRY_DELAY_MS, signal);
      continue;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      // Empty or not JSON (e.g. a proxy's HTML error page).
    }
    if (!res.ok) {
      const issues = Array.isArray(data?.issues) ? data.issues.map(String) : [];
      const message =
        (typeof data?.error === "string" && data.error) ||
        `Request failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""})`;
      const code = typeof data?.code === "string" ? data.code : null;
      throw new ApiError(message, res.status, issues, code);
    }
    return data;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/** @param {string} path @param {{ signal?: AbortSignal }} [options] */
export function getJson(path, options) {
  return request("GET", path, options);
}

/** @param {string} path @param {unknown} body @param {{ signal?: AbortSignal }} [options] */
export function postJson(path, body, options) {
  return request("POST", path, { ...options, body });
}

/** Builds "?a=1&b=2", leaving out empty values ("" when there are none). */
export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

const enc = encodeURIComponent;

// ---- Reads ----

/**
 * @param {{ limit?: number, offset?: number, status?: string }} params
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchRuns(params, options) {
  return getJson(`/api/runs${queryString(params)}`, options);
}

/**
 * @param {number} id
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchRun(id, options) {
  return getJson(`/api/runs/${enc(id)}`, options);
}

/**
 * @param {{ period?: string, days?: number, target?: string }} params
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchTrend(params, options) {
  return getJson(`/api/runs/trend${queryString(params)}`, options);
}

/**
 * @param {string} tag
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchBaselineHistory(tag, options) {
  return getJson(`/api/baselines/${enc(tag)}/history`, options);
}

/**
 * @param {string} tag
 * @param {number} version
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchBaselineVersion(tag, version, options) {
  return getJson(`/api/baselines/${enc(tag)}/versions/${enc(version)}`, options);
}

// ---- Actions ----

/**
 * Accepts a run's current capture as the new baseline.
 * @param {number} runId
 * @param {{ pages?: string[], force?: boolean }} [body] leave out pages to accept everything
 * @param {{ signal?: AbortSignal }} [options]
 */
export function acceptRun(runId, body = {}, options) {
  return postJson(`/api/runs/${enc(runId)}/accept`, body, options);
}

/**
 * @param {string} tag
 * @param {number} version
 * @param {{ signal?: AbortSignal }} [options]
 */
export function restoreBaseline(tag, version, options) {
  return postJson(`/api/baselines/${enc(tag)}/restore`, { version }, options);
}
