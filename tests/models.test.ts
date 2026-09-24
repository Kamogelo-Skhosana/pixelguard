/**
 * Tests for the judgement fields on DiffResult.
 *
 * Ticket: P024
 */

import { describe, expect, it } from "vitest";
import {
  isJudged,
  withJudgeError,
  withJudgement,
  type DiffResult,
  type Judgement,
} from "../src/diff/models.js";

const diff: DiffResult = {
  page: "home",
  viewport: "desktop",
  pixelDiffCount: 100,
  totalPixels: 1000,
  percentChanged: 10,
  changed: true,
  sizeChanged: false,
  baselineSize: { width: 100, height: 10 },
  currentSize: { width: 100, height: 10 },
  diffImagePath: "d.png",
  baselineImagePath: "b.png",
  currentImagePath: "c.png",
};

const judgement: Judgement = {
  verdict: "Real Bug",
  confidence: 8,
  explanation: "  The button overlaps the price.  ",
  observedChanges: ["Button moved up"],
};

describe("withJudgement", () => {
  it("fills in the verdict fields on a copy", () => {
    const judged = withJudgement(diff, judgement, "claude-sonnet-5");
    expect(judged).toEqual({
      ...diff,
      verdict: "Real Bug",
      confidence: 8,
      explanation: "The button overlaps the price.",
      observedChanges: ["Button moved up"],
      judgedBy: "claude-sonnet-5",
    });
    expect(diff.verdict).toBeUndefined(); // original untouched
  });

  it("defaults observedChanges to an empty list", () => {
    const { observedChanges: _, ...noChanges } = judgement;
    expect(withJudgement(diff, noChanges, "m").observedChanges).toEqual([]);
  });

  it("clears an earlier judge error", () => {
    const retried = withJudgement(withJudgeError(diff, "timeout"), judgement, "m");
    expect(retried.judgeError).toBeUndefined();
    expect(isJudged(retried)).toBe(true);
  });

  it.each([
    ["an unknown verdict", { verdict: "Bug" as Judgement["verdict"] }, /Unknown verdict/],
    ["confidence 0", { confidence: 0 }, /1 to 10/],
    ["confidence 11", { confidence: 11 }, /1 to 10/],
    ["confidence 7.5", { confidence: 7.5 }, /whole number/],
    ["an empty explanation", { explanation: "   " }, /cannot be empty/],
  ])("rejects %s", (_label, change, error) => {
    expect(() => withJudgement(diff, { ...judgement, ...change }, "m")).toThrow(error);
  });
});

describe("withJudgeError", () => {
  it("marks the diff Uncertain for human review and records the error", () => {
    const failed = withJudgeError(diff, "API timed out", "claude-sonnet-5");
    expect(failed).toEqual({
      ...diff,
      verdict: "Uncertain",
      explanation: "Could not be judged automatically: API timed out",
      judgeError: "API timed out",
      judgedBy: "claude-sonnet-5",
    });
  });

  it("drops fields from an earlier successful judgement", () => {
    const failed = withJudgeError(withJudgement(diff, judgement, "m"), "bad reply");
    expect(failed.confidence).toBeUndefined();
    expect(failed.observedChanges).toBeUndefined();
    expect(failed.judgedBy).toBeUndefined();
  });
});

describe("isJudged", () => {
  it("is true only for a real verdict", () => {
    expect(isJudged(diff)).toBe(false);
    expect(isJudged(withJudgement(diff, judgement, "m"))).toBe(true);
    expect(isJudged(withJudgeError(diff, "x"))).toBe(false);
  });
});
