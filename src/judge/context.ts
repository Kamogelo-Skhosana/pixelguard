/**
 * Change-context schema.
 *
 * Describes what pixelguard needs to know to judge a diff meaningfully:
 *
 * 1. Known dynamic regions — parts of a page that change on their own
 *    (timestamps, ads, carousels, live counters...). Each region says where
 *    it is and how to treat it:
 *      - "ignore": exclude it from the pixel diff entirely (masked out)
 *      - "inform": keep it in the diff, but tell the AI judge it's expected
 *        to change, so a difference there is weighted as likely acceptable
 *
 * 2. A short description of what changed in this build (P020), e.g.
 *    "Redesigned the checkout button", which helps the judge tell an
 *    intended change from a regression.
 *
 * Example regions file (loaded in P019):
 *
 *   {
 *     "regions": [
 *       { "page": "/", "label": "Footer year", "kind": "timestamp",
 *         "selector": "#copyright", "handling": "ignore" },
 *       { "page": "*", "viewport": "mobile", "label": "Cookie banner", "kind": "banner",
 *         "rect": { "x": 0, "y": 0, "width": 390, "height": 80 }, "handling": "ignore" },
 *       { "page": "/", "label": "Hero carousel", "kind": "carousel",
 *         "selector": ".hero-slider", "handling": "inform" }
 *     ]
 *   }
 *
 * Tickets: P018, P019, P020
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { pageName } from "../capture/pages.js";

export const REGION_KINDS = [
  "timestamp",
  "ad",
  "carousel",
  "animation",
  "banner",
  "user-content",
  "live-data",
  "other",
] as const;

export const REGION_HANDLING = ["ignore", "inform"] as const;

const RectSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const DynamicRegionSchema = z
  .object({
    /** Page path ("/about") or name ("about"), or "*" for every page. */
    page: z.string().trim().min(1),
    /** Viewport name ("mobile"), or "*" for every viewport. Default: "*". */
    viewport: z.string().trim().min(1).default("*"),
    /** Short human-readable name, shown in reports and to the AI judge. */
    label: z.string().trim().min(1),
    kind: z.enum(REGION_KINDS).default("other"),
    /** CSS selector for the element; its box is measured at capture time. */
    selector: z.string().trim().min(1).optional(),
    /** Fixed pixel rectangle in the full-page screenshot. */
    rect: RectSchema.optional(),
    handling: z.enum(REGION_HANDLING).default("inform"),
  })
  .strict()
  .refine((r) => (r.selector === undefined) !== (r.rect === undefined), {
    message: 'needs exactly one of "selector" or "rect"',
  });

export const ChangeContextFileSchema = z
  .object({
    regions: z.array(DynamicRegionSchema).default([]),
  })
  .strict();

export type DynamicRegion = z.infer<typeof DynamicRegionSchema>;
export type RegionRect = z.infer<typeof RectSchema>;

/**
 * A region as actually found on a captured page: selector regions are
 * measured at capture time (one rect per matching element); rect regions
 * pass through as-is. Stored in the capture manifest.
 */
export interface ResolvedRegion {
  label: string;
  kind: DynamicRegion["kind"];
  handling: DynamicRegion["handling"];
  selector?: string;
  /** Boxes in full-page screenshot pixels. Empty if the selector matched nothing visible. */
  rects: RegionRect[];
}

export interface ChangeContext {
  dynamicRegions: DynamicRegion[];
  /** What changed in this build, in the developer's words (P020). */
  changeDescription: string;
}

/** Thrown when a change-context file doesn't match the schema. */
export class ChangeContextError extends Error {
  constructor(
    public readonly issues: string[],
    source = "change context"
  ) {
    super(`Invalid ${source}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ChangeContextError";
  }
}

/** Formats a zod issue path like ["regions", 2, "rect", "width"] as "regions[2].rect.width". */
function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    ""
  );
}

/**
 * Validates raw change-context data (e.g. parsed JSON) and returns the
 * regions with defaults applied. Throws ChangeContextError listing every problem.
 */
export function parseDynamicRegions(input: unknown, source?: string): DynamicRegion[] {
  const parsed = ChangeContextFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ChangeContextError(
      parsed.error.issues.map((i) => {
        const where = formatPath(i.path);
        return where ? `${where}: ${i.message}` : i.message;
      }),
      source
    );
  }
  return parsed.data.regions;
}

export function defaultChangeContext(): ChangeContext {
  return { dynamicRegions: [], changeDescription: "" };
}

/** Longest change description accepted (it goes into every judge prompt). */
export const MAX_CHANGE_DESCRIPTION_LENGTH = 1000;

/**
 * Cleans up a change description: trims it, normalises line endings, and
 * collapses runs of blank lines. Throws if it's longer than
 * MAX_CHANGE_DESCRIPTION_LENGTH. Returns "" for empty input.
 */
export function normalizeChangeDescription(text: string | undefined): string {
  if (!text) return "";
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length > MAX_CHANGE_DESCRIPTION_LENGTH) {
    throw new Error(
      `The change description is ${cleaned.length} characters; keep it under ` +
        `${MAX_CHANGE_DESCRIPTION_LENGTH} (a short summary works best).`
    );
  }
  return cleaned;
}

/** Default regions file, looked for in the current folder. */
export const DEFAULT_REGIONS_FILE = "pixelguard.regions.json";

/**
 * Loads dynamic regions from a JSON file.
 * A missing file is fine (no regions) unless required is true — used when
 * the user explicitly pointed REGIONS_FILE at a file.
 */
export async function loadDynamicRegions(
  path: string,
  options: { required?: boolean } = {}
): Promise<DynamicRegion[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !options.required) return [];
    throw new ChangeContextError([`could not read the file: ${(err as Error).message}`], path);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ChangeContextError([`not valid JSON: ${(err as Error).message}`], path);
  }
  return parseDynamicRegions(data, path);
}

/** True when region applies to this page (name or path) and viewport. */
export function regionMatches(region: DynamicRegion, page: string, viewport: string): boolean {
  const pageOk = region.page === "*" || pageName(region.page) === pageName(page);
  const viewportOk =
    region.viewport === "*" || region.viewport.toLowerCase() === viewport.toLowerCase();
  return pageOk && viewportOk;
}

/** The regions that apply to one page/viewport, split by how to handle them. */
export function regionsFor(
  context: ChangeContext,
  page: string,
  viewport: string
): { ignore: DynamicRegion[]; inform: DynamicRegion[] } {
  const matching = context.dynamicRegions.filter((r) => regionMatches(r, page, viewport));
  return {
    ignore: matching.filter((r) => r.handling === "ignore"),
    inform: matching.filter((r) => r.handling === "inform"),
  };
}

/** Plain-English list of regions for reports and the judge prompt. */
export function describeRegions(regions: DynamicRegion[]): string {
  if (regions.length === 0) return "none";
  return regions
    .map((r) => {
      const where = r.selector
        ? `element "${r.selector}"`
        : `area x=${r.rect!.x}, y=${r.rect!.y}, ${r.rect!.width}x${r.rect!.height}px`;
      const how =
        r.handling === "ignore"
          ? "excluded from the pixel diff"
          : "expected to change; differences here are likely acceptable";
      return `- ${r.label} (${r.kind}) at ${where}: ${how}`;
    })
    .join("\n");
}
