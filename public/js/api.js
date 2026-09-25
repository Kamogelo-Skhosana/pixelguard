// Small client for the dashboard API. Ticket: P039

export class ApiError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * GETs JSON from the API, turning HTTP and network errors into ApiError.
 * @param {string} path
 */
export async function getJson(path) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(
      "Can't reach the pixelguard server. Is `pixelguard dashboard` still running?",
      0
    );
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new ApiError((body && body.error) || `Request failed (HTTP ${res.status})`, res.status);
  }
  return body;
}

/**
 * @param {{ limit?: number, offset?: number, status?: string }} query
 */
export function fetchRuns(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return getJson(`/api/runs?${params}`);
}
