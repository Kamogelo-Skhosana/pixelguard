/**
 * Configuration loading for pixelguard.
 *
 * Loads settings from a .env file (see .env.example) and exposes them
 * as a single Settings object used across the capture, diff, judge,
 * and report layers.
 *
 * Ticket: P011
 */

import "dotenv/config";
import { DEFAULT_VIEWPORTS, type ViewportConfig } from "./capture/capture.js";

export interface Settings {
  targetBaseUrl: string;
  targetPages: string[];
  viewports: ViewportConfig[];
  outputDir: string;
  llmApiKey: string;
  llmModel: string;
  /** Raw DATABASE_URL value, e.g. "sqlite:./pixelguard.db". */
  databaseUrl: string;
  /** Plain file path for better-sqlite3, derived from databaseUrl. */
  databasePath: string;
}

/**
 * Converts a DATABASE_URL like "sqlite:./pixelguard.db" or
 * "sqlite:///abs/path.db" into a plain file path better-sqlite3 can open.
 * Values without a "sqlite:" prefix are returned unchanged.
 */
export function sqlitePathFromUrl(databaseUrl: string): string {
  const match = /^sqlite:(?:\/\/)?(.*)$/i.exec(databaseUrl.trim());
  return match ? match[1] : databaseUrl.trim();
}

export function loadSettings(): Settings {
  // TODO (P011): validate required fields are present and raise a
  // clear error pointing the user at .env.example if not; allow
  // viewports to be overridden from config.
  const databaseUrl = process.env.DATABASE_URL ?? "sqlite:./pixelguard.db";
  return {
    targetBaseUrl: process.env.TARGET_BASE_URL ?? "http://localhost:3000",
    targetPages: (process.env.TARGET_PAGES ?? "/").split(",").map((p) => p.trim()),
    viewports: DEFAULT_VIEWPORTS,
    outputDir: process.env.OUTPUT_DIR ?? "screenshots",
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    databaseUrl,
    databasePath: sqlitePathFromUrl(databaseUrl),
  };
}
