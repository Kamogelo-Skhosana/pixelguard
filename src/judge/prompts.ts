/**
 * Prompt templates for the judge layer.
 *
 * Ticket: P021
 */

export const JUDGE_PROMPT_TEMPLATE = `
You are a senior QA engineer reviewing a visual change to a web page.
You are given three images, in this order:
  1. BASELINE — the page before the change
  2. CURRENT  — the page after the change
  3. DIFF     — changed pixels highlighted
Compare BASELINE and CURRENT (using DIFF to locate the changes) and decide
whether the difference is a real visual bug or an acceptable/expected change.

Page: {page}
Viewport: {viewport}
Percent of pixels changed: {percentChanged}%
Known dynamic regions on this page: {knownDynamicRegions}
What changed in this build (developer note): {changeDescription}

Respond with a JSON object containing:
  - verdict ("Real Bug" | "Acceptable Change" | "Uncertain")
  - confidence (1-10)
  - explanation (plain-English, 2-3 sentences)
`;
