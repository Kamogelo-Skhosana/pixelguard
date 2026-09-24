/**
 * Internal DiffResult data model — the normalized shape every pixel
 * diff gets represented as before it reaches the judge layer.
 *
 * Ticket: P013
 */

export type Verdict = "Real Bug" | "Acceptable Change" | "Uncertain";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  /** Page name, e.g. "home" (see pageName() in capture.ts). */
  page: string;
  /** Viewport name, e.g. "desktop". */
  viewport: string;

  /** Number of pixels that differ between baseline and current. */
  pixelDiffCount: number;
  /** Pixels compared: width x height of the (padded) comparison area. */
  totalPixels: number;
  /**
   * pixelDiffCount as a percentage of totalPixels (0-100), rounded to 4
   * decimal places. Never rounds a real change down to 0.
   */
  percentChanged: number;
  /** True when any pixel differs. */
  changed: boolean;

  /** True when the baseline and current screenshots have different dimensions. */
  sizeChanged: boolean;
  baselineSize: ImageSize;
  currentSize: ImageSize;

  diffImagePath: string;
  baselineImagePath: string;
  currentImagePath: string;

  /** Known dynamic regions left out of the comparison (handling "ignore"). */
  ignoredRegions?: { label: string; rect: ImageRect }[];
  /** Known dynamic regions expected to change (handling "inform"), for the judge. */
  expectedChangeRegions?: { label: string; kind: string; rect: ImageRect }[];

  // ---- Judgement (Phase 2, P024) — set by the judge layer ----
  // Screenshots that didn't change aren't sent to the judge, so these stay unset.

  /** The judge's verdict. "Uncertain" is also used when judging failed (see judgeError). */
  verdict?: Verdict;
  /** 1 (a guess) to 10 (certain). Unset when judging failed. */
  confidence?: number;
  /** Plain-English reasoning for the verdict. */
  explanation?: string;
  /** Short descriptions of each visible change the judge noticed. */
  observedChanges?: string[];
  /** Model that produced the verdict, e.g. "claude-sonnet-5". */
  judgedBy?: string;
  /** Set when the judge couldn't produce a verdict (API error, unreadable reply...). */
  judgeError?: string;
}

/** A verdict as returned by the judge (see JudgeResponseSchema in judge/prompts.ts). */
export interface Judgement {
  verdict: Verdict;
  confidence: number;
  explanation: string;
  observedChanges?: string[];
}

export const VERDICT_VALUES: readonly Verdict[] = ["Real Bug", "Acceptable Change", "Uncertain"];

/**
 * Returns a copy of diff with the judge's verdict filled in (clearing any
 * earlier judge error). Throws if the judgement is malformed.
 */
export function withJudgement(diff: DiffResult, judgement: Judgement, model: string): DiffResult {
  if (!VERDICT_VALUES.includes(judgement.verdict)) {
    throw new Error(`Unknown verdict "${judgement.verdict}"`);
  }
  if (
    !Number.isInteger(judgement.confidence) ||
    judgement.confidence < 1 ||
    judgement.confidence > 10
  ) {
    throw new Error(`Confidence must be a whole number from 1 to 10 (got ${judgement.confidence})`);
  }
  if (judgement.explanation.trim() === "") {
    throw new Error("Explanation cannot be empty");
  }

  const { judgeError: _previousError, ...rest } = diff;
  return {
    ...rest,
    verdict: judgement.verdict,
    confidence: judgement.confidence,
    explanation: judgement.explanation.trim(),
    observedChanges: judgement.observedChanges ?? [],
    judgedBy: model,
  };
}

/**
 * Returns a copy of diff marked as "couldn't be judged". The verdict is set
 * to "Uncertain" so the screenshot is flagged for human review rather than
 * silently passing.
 */
export function withJudgeError(diff: DiffResult, error: string, model?: string): DiffResult {
  const { confidence: _c, observedChanges: _o, judgedBy: _j, ...rest } = diff;
  return {
    ...rest,
    verdict: "Uncertain",
    explanation: `Could not be judged automatically: ${error}`,
    judgeError: error,
    ...(model && { judgedBy: model }),
  };
}

/** True when diff has a verdict from the judge (not a failed attempt). */
export function isJudged(diff: DiffResult): boolean {
  return diff.verdict !== undefined && diff.judgeError === undefined;
}

/** Smallest percentage reported for a real change, so it never shows as 0%. */
export const MIN_REPORTED_PERCENT = 0.0001;

/**
 * Converts a changed-pixel count into a percentage of the total (0-100),
 * rounded to 4 decimal places. Any change above zero reports at least
 * MIN_REPORTED_PERCENT, so a handful of changed pixels on a huge
 * full-page screenshot is never hidden as "0%".
 */
export function calculatePercentChanged(pixelDiffCount: number, totalPixels: number): number {
  if (!Number.isFinite(pixelDiffCount) || pixelDiffCount < 0) {
    throw new Error(`pixelDiffCount must be a non-negative number (got ${pixelDiffCount})`);
  }
  if (!Number.isFinite(totalPixels) || totalPixels <= 0) {
    throw new Error(`totalPixels must be a positive number (got ${totalPixels})`);
  }
  if (pixelDiffCount > totalPixels) {
    throw new Error(`pixelDiffCount (${pixelDiffCount}) exceeds totalPixels (${totalPixels})`);
  }
  if (pixelDiffCount === 0) return 0;

  const percent = Math.round((pixelDiffCount / totalPixels) * 100 * 10_000) / 10_000;
  return Math.max(percent, MIN_REPORTED_PERCENT);
}
