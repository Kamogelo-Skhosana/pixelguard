/**
 * Prompt templates for the judge layer.
 *
 * Ticket: P021
 */

export const JUDGE_PROMPT_TEMPLATE = `
You are a senior QA engineer reviewing a visual diff between a baseline
and current screenshot of a web page. Decide whether this difference is
a real visual bug or an acceptable/expected change.

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
