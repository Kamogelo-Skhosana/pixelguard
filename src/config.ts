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

export interface Settings {
  targetBaseUrl: string;
  targetPages: string[];
  llmApiKey: string;
  llmModel: string;
  databaseUrl: string;
}

export function loadSettings(): Settings {
  // TODO (P011): validate required fields are present and raise a
  // clear error pointing the user at .env.example if not.
  return {
    targetBaseUrl: process.env.TARGET_BASE_URL ?? "http://localhost:3000",
    targetPages: (process.env.TARGET_PAGES ?? "/").split(","),
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    databaseUrl: process.env.DATABASE_URL ?? "sqlite:./pixelguard.db",
  };
}
