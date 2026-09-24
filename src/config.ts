/**
 * Configuration loading for pixelguard.
 *
 * Loads settings from a .env file (see .env.example), validates them,
 * and exposes them as a single Settings object used across the capture,
 * diff, judge, and report layers.
 *
 * Ticket: P011
 */

import "dotenv/config";
import { z } from "zod";

export interface ViewportConfig {
  name: string; // e.g. "desktop", "mobile"
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORTS: ViewportConfig[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

export interface Settings {
  /** Base URL of the app under test, without a trailing slash. */
  targetBaseUrl: string;
  /** Page paths to capture, each starting with "/". */
  targetPages: string[];
  viewports: ViewportConfig[];
  /** Root folder for screenshots (screenshots/<tag>/<viewport>/<page>.png). */
  outputDir: string;
  /** Root folder for diff images (diffs/<baseline>-vs-<current>/<viewport>/<page>.png). */
  diffDir: string;
  /** JSON file listing known dynamic regions (see judge/context.ts). */
  regionsFile: string;
  /** True when REGIONS_FILE was set explicitly, so a missing file is an error. */
  regionsFileRequired: boolean;
  /** Empty until the judge layer is used (Phase 2). */
  llmApiKey: string;
  llmModel: string;
  /** Raw DATABASE_URL value, e.g. "sqlite:./pixelguard.db". */
  databaseUrl: string;
  /** Plain file path for better-sqlite3, derived from databaseUrl. */
  databasePath: string;
}

/** Thrown when .env values are missing or invalid. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid pixelguard configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n` +
        `Copy .env.example to .env and check these values.`
    );
    this.name = "ConfigError";
  }
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

/**
 * Parses TARGET_PAGES ("/, /search ,checkout") into normalized paths
 * (["/", "/search", "/checkout"]). Empty entries and duplicates are dropped.
 */
export function parsePages(raw: string): string[] {
  const pages = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
  return [...new Set(pages)];
}

/**
 * Parses VIEWPORTS ("desktop:1440x900, mobile:390x844") into
 * ViewportConfig objects. Throws a plain Error describing the first bad entry.
 */
export function parseViewports(raw: string): ViewportConfig[] {
  const entries = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  const viewports = entries.map((entry) => {
    const match = /^([a-z0-9_-]+):(\d+)x(\d+)$/i.exec(entry);
    if (!match) {
      throw new Error(`VIEWPORTS entry "${entry}" must look like name:WIDTHxHEIGHT`);
    }
    const [, name, width, height] = match;
    const viewport = { name: name.toLowerCase(), width: Number(width), height: Number(height) };
    if (viewport.width < 1 || viewport.height < 1) {
      throw new Error(`VIEWPORTS entry "${entry}" must have a width and height above 0`);
    }
    return viewport;
  });

  const names = viewports.map((v) => v.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) {
    throw new Error(`VIEWPORTS has the name "${duplicate}" more than once`);
  }
  return viewports;
}

const EnvSchema = z.object({
  TARGET_BASE_URL: z
    .string({ required_error: "TARGET_BASE_URL is required (e.g. http://localhost:3000)" })
    .trim()
    .url("TARGET_BASE_URL must be a full URL (e.g. http://localhost:3000)")
    .refine((u) => /^https?:\/\//i.test(u), "TARGET_BASE_URL must start with http:// or https://"),
  TARGET_PAGES: z.string().default("/"),
  VIEWPORTS: z.string().optional(),
  OUTPUT_DIR: z.string().trim().min(1, "OUTPUT_DIR cannot be empty").default("screenshots"),
  DIFF_DIR: z.string().trim().min(1, "DIFF_DIR cannot be empty").default("diffs"),
  REGIONS_FILE: z.string().trim().optional(),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().trim().min(1, "LLM_MODEL cannot be empty").default("claude-sonnet-4-6"),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, "DATABASE_URL cannot be empty")
    .default("sqlite:./pixelguard.db"),
});

/**
 * Loads and validates settings. Pass a custom env object in tests;
 * defaults to process.env (populated from .env by dotenv).
 * Throws ConfigError listing every problem found.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // Treat blank values ("KEY=") as unset so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")
  );

  const parsed = EnvSchema.safeParse(cleaned);
  const issues: string[] = parsed.success ? [] : parsed.error.issues.map((i) => i.message);

  // Page and viewport checks run even if the schema failed, so the user
  // sees every problem in one go.
  const targetPages = parsePages(cleaned.TARGET_PAGES ?? "/");
  if (targetPages.length === 0) {
    issues.push("TARGET_PAGES must list at least one page path (e.g. /,/about)");
  }

  let viewports: ViewportConfig[] = DEFAULT_VIEWPORTS;
  if (cleaned.VIEWPORTS) {
    try {
      viewports = parseViewports(cleaned.VIEWPORTS);
    } catch (err) {
      issues.push((err as Error).message);
    }
  }

  if (!parsed.success || issues.length > 0) {
    throw new ConfigError(issues);
  }

  const data = parsed.data;
  return {
    targetBaseUrl: data.TARGET_BASE_URL.replace(/\/+$/, ""),
    targetPages,
    viewports,
    outputDir: data.OUTPUT_DIR,
    diffDir: data.DIFF_DIR,
    regionsFile: data.REGIONS_FILE ?? "pixelguard.regions.json",
    regionsFileRequired: data.REGIONS_FILE !== undefined,
    llmApiKey: data.LLM_API_KEY,
    llmModel: data.LLM_MODEL,
    databaseUrl: data.DATABASE_URL,
    databasePath: sqlitePathFromUrl(data.DATABASE_URL),
  };
}
