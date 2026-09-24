/**
 * Tests for the judge layer, using a mocked LLM client.
 *
 * Tickets: P021-P028
 */

import { describe, it, expect, vi } from "vitest";

describe("judgeDiff", () => {
  it.todo("populates verdict, confidence, and explanation from a mocked LLM response (P025)");
});

describe("summarizeRun", () => {
  it.todo("correctly counts real bugs, acceptable changes, and uncertain verdicts (P026/P027)");
});
