// What the dashboard server told us about itself (GET /api/health). Ticket: P047

import { getJson } from "./api.js";

/** Filled in by loadServerInfo() before the first page is drawn. */
export const server = {
  /** True when accepting and restoring baselines is turned off (--read-only). */
  readOnly: false,
  version: "",
};

/**
 * Reads /api/health once. If it fails, the dashboard still works: pages show
 * their own errors, and the server refuses actions itself when read-only.
 */
export async function loadServerInfo() {
  try {
    const health = await getJson("/api/health");
    server.readOnly = health?.readOnly === true;
    server.version = typeof health?.version === "string" ? health.version : "";
  } catch {
    // Keep the defaults.
  }
  document.body.dataset.readOnly = String(server.readOnly);
  const badge = document.getElementById("read-only-badge");
  if (badge) badge.hidden = !server.readOnly;
}
