# Markdown Report Template

Design for the AI-judged Markdown report written by `pixelguard diff --judge --report report.md` (P029). It is implemented by `generateMarkdownReport()` in `src/report/markdown.ts` (P030); the CLI flag is P031.

A complete example that follows this design, rendered from real sample screenshots, is in [`examples/sample-report/report.md`](../examples/sample-report/report.md).

## Goals

- **Answer "can we ship?" in the first line.** The run result comes first, before any detail.
- **Worst first.** Failing pages, then pages to review, then passing pages. Nobody should have to scroll past green to find red.
- **Explain, don't just show.** Every changed screenshot gets the judge's verdict, confidence and plain-English explanation next to its images.
- **Readable anywhere.** Renders well on GitHub (PR comments, repo files), in VS Code's preview and in plain text. Uses only standard Markdown plus `<img>` and `<details>`, which GitHub supports.
- **Works before judging too.** A report from a run without `--judge` is still valid — changes just show as "not judged".

## Structure

```
# pixelguard report
> [result banner]

[run details table]
[developer note, if any]

## Summary
[verdict counts table]
[pages table, worst first, linking to each page section]

## Failing pages              (only if any)
### checkout
...one block per changed viewport...

## Pages to review            (only if any)
### home
...

## Passing pages              (only if any)
[compact table — no images]

---
[footer]
```

Empty sections are left out entirely.

### 1. Title and result banner

```markdown
# pixelguard report

> ❌ **FAIL:** 1 real bug on 1 page, 1 uncertain, 1 not compared, 1 acceptable change (4 pages checked)
```

- The banner is the run `headline` from `summarizeRun()` (P027) with the status word in bold.
- Status marks are used consistently everywhere: **❌ fail**, **⚠️ review**, **✅ pass**.

### 2. Run details

A two-column table. Rows with no value are left out.

| Row       | Source                                         |
| --------- | ---------------------------------------------- |
| Target    | `targetUrl` from the current capture           |
| Compared  | `` `baseline` → `current` `` tags              |
| Judge     | model name(s) from `judgedBy`, or "not judged" |
| Generated | ISO time, UTC                                  |

The developer's change description (P020), if given, follows as a blockquote under **What changed in this build**, keeping its line breaks.

### 3. Summary

**Verdict counts** — one row per non-zero count, in this fixed order: Real bugs, Uncertain, Couldn't be judged, Changed but not judged, Not compared, Acceptable changes, Unchanged. Counts are screenshots (page × viewport), so the table says "Screenshots".

**Pages table** — `Page | Status | Summary`, worst first, then in capture order. Each page name links to its section (`[checkout](#checkout)`); passing pages link to the passing table.

### 4. Page sections (failing and review pages)

One `###` heading per page containing **only the page name** (`### checkout`), so its anchor is simply `#checkout` — emoji or status words in a heading would change GitHub's anchor and break the links from the summary table. The next line gives the status and the page summary from `rollupPages()` (P026): `**❌ FAIL** · _Real Bug on mobile (9/10)_`.

Then one `####` block per viewport **that changed or wasn't compared**, worst first:

```markdown
#### mobile — Real Bug (9/10)

- **Changed:** 0.83% of the page (200 pixels)
- **Page size:** height 2000px → 2300px ← only if the size changed
- **Ignored regions:** Cookie banner ← only if any were masked

> The checkout button has shifted right and now sits partly outside its card…

**What the judge saw:**

- Checkout button moved 5px right

| Baseline                  | Current                   | Diff                      |
| ------------------------- | ------------------------- | ------------------------- |
| <img src="…" width="260"> | <img src="…" width="260"> | <img src="…" width="260"> |
```

- The explanation is a blockquote so it stands out from the numbers.
- "What the judge saw" lists `observedChanges`; it's left out when empty.
- For a failed judgement, the heading reads `#### mobile — Couldn't be judged` and the blockquote gives the `judgeError`.
- For an unjudged change, the heading reads `#### mobile — Changed (not judged)` and there's no blockquote.
- Images are shown side by side at a fixed width of 260px, and each is also a link to the full-size file (thumbnails of tall full-page screenshots are hard to read).
- Viewports that didn't change are listed on one line at the end of the section: `Unchanged: desktop, tablet.`
- Screenshots that couldn't be compared get a short block with the reason (`#### desktop — Not compared`) inside their page's section — there's no separate "not compared" section, so nothing is listed twice.

### 5. Passing pages

A compact table without images — `Page | Summary` — because nobody needs to look at them. Acceptable changes still show their summary (e.g. "Acceptable changes on desktop") so reviewers can see what changed.

### 6. Footer

```markdown
---

Generated by [pixelguard](https://github.com/Kamogelo-Skhosana/pixelguard) · JSON results: `diffs.json`
```

The JSON link only appears when `--output` was also given.

## Rules for the generator (P030)

1. **Relative image paths.** Image links are relative to the folder the report is written to, with forward slashes (also on Windows) and URL-encoded characters where needed (e.g. spaces → `%20`). This keeps the report working when the folder is moved, zipped, or committed.
2. **Escaping.** Text from outside pixelguard — page names, explanations, observed changes, the developer note, error messages — is escaped so it can't break the layout: `|` in table cells, leading `#`, `>`, `-` or numbers at the start of a line, and HTML `<`/`>` characters. Newlines inside table cells become spaces.
3. **No emoji in headings.** GitHub builds anchors by lowercasing, dropping punctuation and emoji, and turning each space into `-` — so `## ✅ Passing pages` becomes `#-passing-pages` (leading dash) and links break. Status marks go in the text under a heading, never in the heading itself.
4. **Anchors.** Page headings get stable anchors from the page name (GitHub-style: lowercase, spaces → `-`, punctuation removed). Page names are already file-safe (`pageName()`), so anchors match them.
5. **Ordering.** Sections: fail → review → pass. Within a page: fail → review → pass viewports. Ties keep capture order.
6. **Deterministic.** The same input always produces the same report (apart from the "Generated" time, which is passed in), so it can be snapshot-tested.
7. **No judge, no problem.** Without verdicts, changed screenshots show as "Changed (not judged)" and their pages are "review" — the report is still useful as a visual change log.
