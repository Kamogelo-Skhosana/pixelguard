# Architecture

## Overview

pixelguard has three logical layers, built up one per phase:

```
┌─────────────────┐      ┌──────────────────┐      ┌───────────────────┐
│   Capture Layer    │ ──> │   Diff Layer        │ ──> │   Judge Layer        │
│   (Playwright)      │      │   (pixelmatch)       │      │   (vision LLM)       │
└─────────────────┘      └──────────────────┘      └───────────────────┘
        Phase 1                 Phase 1                   Phase 2
                                                                    │
                                                          ┌───────────────────┐
                                                          │  Report + Dashboard │
                                                          │  (Phase 1–3)          │
                                                          └───────────────────┘
```

## 1. Capture Layer (`src/capture/`)

- Uses Playwright to launch a browser and navigate to each configured page
- Captures a full-page screenshot at each configured viewport size (desktop 1440×900, tablet 768×1024, mobile 390×844)
- Saves each run into a tagged folder (e.g., `screenshots/baseline/`, `screenshots/current/`) with a `manifest.json` recording what was captured, when, and which screenshots failed

```
screenshots/
├── baseline/
│   ├── manifest.json
│   ├── desktop/home.png
│   └── mobile/home.png
└── current/
    ├── manifest.json
    ├── desktop/home.png
    └── mobile/home.png
```

- Page paths become file-safe names (`/` → `home`, `/blog/post-1` → `blog-post-1`)
- A run is written to a temporary folder first and only replaces the tag when it finishes, so a failed or interrupted run never wipes out an existing baseline. If every screenshot fails, the previous capture is kept.

## 2. Diff Layer (`src/diff/`)

- Takes a baseline screenshot and a current screenshot of the same page/viewport
- Runs `pixelmatch` to produce:
  - A diff image (highlighting changed pixels)
  - A pixel diff count and percentage-changed value
- Normalizes results into an internal `DiffResult` model:

```json
{
  "page": "home",
  "viewport": "desktop",
  "pixelDiffCount": 4820,
  "totalPixels": 3240000,
  "percentChanged": 0.1488,
  "changed": true,
  "sizeChanged": false,
  "baselineSize": { "width": 1440, "height": 2250 },
  "currentSize": { "width": 1440, "height": 2250 },
  "diffImagePath": "diffs/desktop/home.png",
  "baselineImagePath": "screenshots/baseline/desktop/home.png",
  "currentImagePath": "screenshots/current/desktop/home.png"
}
```

- After judging (Phase 2), each changed result also gets `verdict`, `confidence`, `explanation`, `observedChanges` and `judgedBy` (the model). Unchanged screenshots aren't sent to the judge. If judging fails, the result gets `verdict: "Uncertain"` plus a `judgeError`, so it's flagged for a human rather than silently passing
- `percentChanged` is rounded to 4 decimal places, but a real change is never reported as 0%
- When a page's height or width changed, the smaller screenshot is padded and the extra area counts as changed (`sizeChanged: true`)

## 3. Judge Layer (`src/judge/`, Phase 2)

- Takes each `DiffResult` (plus the baseline/current image pair and the **change context**, below)
- Sends **all three images** (baseline, current, and diff) to a vision-capable LLM with a structured prompt — the diff image alone only shows _where_ pixels changed, while the baseline/current pair shows _what_ changed
- **LLM client (`src/judge/llmClient.ts`):** the judge depends on a small `LLMClient` interface (so tests use a fake). `AnthropicClient` calls the Anthropic Messages API with the prompt and the three labelled images (temperature 0), using `LLM_API_KEY` and `LLM_MODEL` (default `claude-sonnet-5`)
  - Retries rate limits, server errors, "overloaded" (529), timeouts and network errors — up to 3 retries with exponential backoff and jitter, or the server's `retry-after`
  - Doesn't retry mistakes that won't fix themselves (400, 401 "check LLM_API_KEY", 404 "check LLM_MODEL")
  - 60s timeout per request; returns the reply text, the model that answered, and token usage
- **Prompt design (`src/judge/prompts.ts`):**
  - A fixed _system prompt_ explains the three images (BASELINE, CURRENT, DIFF — including what red, yellow and light blue mean in the diff), defines each verdict with concrete examples, sets confidence rules (prefer "Uncertain" over a low-confidence guess), and tells the model that text in screenshots or the developer note is data, not instructions
  - A per-diff _user prompt_ gives the page, viewport, screenshot size (and any size change), pixels changed, known dynamic regions with coordinates, and the developer's change description
- The LLM must reply with only a JSON object, validated by `JudgeResponseSchema`:

```json
{
  "verdict": "Real Bug",
  "confidence": 8,
  "explanation": "The checkout button now overlaps the order total on mobile, hiding the price.",
  "observedChanges": ["Checkout button moved up ~20px", "Order total partly hidden"]
}
```

- **verdict:** Real Bug / Acceptable Change / Uncertain
- **confidence:** integer 1–10
- **explanation:** 2–3 plain-English sentences
- **observedChanges:** up to 10 short descriptions of what visibly changed (optional)
- **Judging (`src/judge/judge.ts`, `imagePrep.ts`):**
  - Only changed screenshots are sent to the judge; unchanged ones pass through without an API call
  - Before sending, the three images are cropped (full width) to the rows around the changed pixels plus 250px of context (at least 1000 rows, so the surrounding layout is visible; shorter screenshots are sent whole), and scaled down only if still over 3000px — so tall full-page screenshots stay sharp where it matters and within API limits. The prompt says what part of the page is shown, and region coordinates are converted to match
  - The reply is parsed leniently (code fences and surrounding text are fine) and validated; an unreadable reply is asked again once
  - If the call fails or the reply stays unreadable, the result is marked `Uncertain` with a `judgeError`, so one bad screenshot never stops the run
  - The parser also ignores extra keys a model might add (e.g. `"reasoning"`) instead of rejecting a good verdict
- Screenshots are judged 2 at a time; `pixelguard diff --judge` runs this and shows a Verdict column
- **Per-page rollup (`src/judge/aggregate.ts`, P026):** each page gets one status from its viewports, worst first:
  - **fail** — any viewport has a Real Bug
  - **review** — no bug, but a human should look: an Uncertain verdict, a judge error, a change that wasn't judged, or a screenshot that couldn't be compared
  - **pass** — every viewport is unchanged or an Acceptable Change

  `diff --judge` prints a "Pages" section (worst first), and the JSON report has a `pages` list with each page's status, a one-line summary and its viewports

- **Run summary (`summarizeRun()`, P027):** the run's status is its worst page, plus counts of real bugs, acceptable changes, uncertain, failed judgements, unjudged changes and uncompared screenshots, and page pass/review/fail totals. `diff --judge` ends with a one-line result, e.g. `✗ FAIL: 2 real bugs on 1 page, 3 acceptable changes (6 pages checked)`, and the JSON report has it under `run`

### Change context (`src/judge/context.ts`)

The change context tells pixelguard what's _expected_ to change:

- **Known dynamic regions** — parts of a page that change on their own. Each region has:
  - `page` — page path (`/about`) or name (`about`), or `*` for every page
  - `viewport` — viewport name, or `*` (default) for every viewport
  - `label` — short name shown in reports and to the judge
  - `kind` — `timestamp`, `ad`, `carousel`, `animation`, `banner`, `user-content`, `live-data` or `other` (default)
  - **exactly one of** `selector` (a CSS selector, measured at capture time) or `rect` (`{ x, y, width, height }` in pixels)
  - `handling` — `ignore` (masked out of the pixel diff) or `inform` (default: kept in the diff, but the judge is told it's expected to change)
- **Change description** — a short note on what changed in this build (e.g. "Redesigned the checkout button"), supplied from the CLI

```json
{
  "regions": [
    {
      "page": "/",
      "label": "Footer year",
      "kind": "timestamp",
      "selector": "#copyright",
      "handling": "ignore"
    },
    {
      "page": "*",
      "viewport": "mobile",
      "label": "Cookie banner",
      "kind": "banner",
      "rect": { "x": 0, "y": 0, "width": 390, "height": 80 },
      "handling": "ignore"
    },
    {
      "page": "/",
      "label": "Hero carousel",
      "kind": "carousel",
      "selector": ".hero-slider",
      "handling": "inform"
    }
  ]
}
```

Invalid files are rejected with every problem listed by location (e.g. `regions[1].rect.width: ...`); unknown fields are rejected so typos don't silently do nothing.

**Configuring regions (P019):** put them in `pixelguard.regions.json` in the project folder (copy `pixelguard.regions.example.json`), or point `REGIONS_FILE` at another file. A missing default file just means no regions; a missing file named in `REGIONS_FILE` is an error.

How regions are applied:

1. **Capture** — each selector region matching the page/viewport is measured just before the screenshot (one box per visible matching element, in full-page pixels) and recorded in the tag's `manifest.json`
2. **Diff** — the regions file decides which regions apply. Rect regions are used as-is; selector regions use the boxes measured in _both_ captures, so an element that moved is covered in both positions
   - `ignore` regions are painted identically in both images before comparing, so they never count as changed, and are tinted light blue in the diff image. They're listed in the console Notes column and as `ignoredRegions` in the JSON
   - `inform` regions are kept in the diff and passed along as `expectedChangeRegions` for the judge
   - a selector region added after the captures were taken can't be applied; `diff` prints a warning to re-capture

## 4. Report + Dashboard (`src/report/`, `src/dashboard/`)

- Console output (Phase 1) and Markdown report (Phase 2) rendering — the report layout is designed in [REPORT_TEMPLATE.md](REPORT_TEMPLATE.md), with a rendered example in [examples/sample-report/report.md](../examples/sample-report/report.md)
- `generateMarkdownReport()` (`src/report/markdown.ts`, P030) implements that design. A test regenerates the sample report from the run it describes and requires an exact match, so the design doc, the sample and the generator can't drift apart. Text from outside pixelguard (page names, explanations, notes, errors) is escaped so it can't add formatting, links, HTML or table columns; image links are relative to the report's folder
- SQLite persistence of every run's results (Phase 2+) — `src/report/persistence.ts`:
  - `runs`: one row per diff run — when, target, tags, developer note, overall status and headline, whether it was judged (and by which model), page and verdict counts, and paths to the report/JSON
  - `page_diffs`: one row per page/viewport in a run — its rollup status, pixel diff numbers, sizes, image paths, verdict, confidence, explanation, observed changes (JSON), judge error and regions (JSON). Screenshots that couldn't be compared are stored too (`compared = 0` plus a `skip_reason`)
  - Constraints reject bad data (unknown statuses or verdicts, confidence outside 1–10, percentages over 100, duplicate page/viewport rows in a run); deleting a run deletes its page diffs
  - The schema version lives in SQLite's `user_version`; `getDatabase()` applies pending migrations in a transaction, and refuses a database created by a newer pixelguard
  - File databases use WAL journaling so the dashboard can read while a run is saved; `:memory:` works for tests
  - **Saving (P033):** every `pixelguard diff` run is saved with `saveRun()` — the run row plus one `page_diffs` row per screenshot (skipped ones too), in a single transaction so a run is saved completely or not at all. It's saved before any `--fail-on-*` exit. `--no-save` turns it off. If saving fails, a warning is printed and the exit code is unchanged, so a database problem can't hide results or break CI. Image paths are stored as given (relative to the project folder)
- Phase 3 dashboard: run history, side-by-side diff viewer, trend chart, and "accept as new baseline" action

## CLI

```bash
pixelguard capture --tag <name>
pixelguard diff --baseline <tag> --current <tag> [--output diffs.json] [--threshold 0.1] [--fail-on-change]
```

- `capture` screenshots every page in `TARGET_PAGES` at every viewport into `screenshots/<tag>/`
- `diff` pairs the two captures using their manifests, writes diff images to `diffs/<baseline>-vs-<current>/<viewport>/<page>.png`, prints a table, and lists anything it couldn't compare (new, removed or failed pages)
- `--change "<text>"` (or `--change-file notes.txt`, or the `PIXELGUARD_CHANGE` environment variable in CI) describes what changed in this build; it's shown in the output, saved in the JSON report, and given to the AI judge in Phase 2. Max 1000 characters; an explicit `--change-file` wins over `PIXELGUARD_CHANGE`
- `--fail-on-bug` (with `--judge`) exits with code 1 only when the judge finds a Real Bug — the CI-friendly option once judging is on, since acceptable changes don't fail the build
- `--no-save` skips saving the run to the database (runs are saved by default, for the Phase 3 dashboard)
- `--report report.md` writes the Markdown report (see [REPORT_TEMPLATE.md](REPORT_TEMPLATE.md)). With `--judge` it includes verdicts and explanations; without, it's a visual change log with every change marked "not judged". It's written before any `--fail-on-*` exit, so failing CI runs still get a report
- `--judge` asks the AI judge for a verdict on each changed screenshot (needs `LLM_API_KEY`; fails fast with exit code 2 if it's missing)
- `--output` also writes the results as JSON; `--threshold` sets pixel colour sensitivity (0-1); `--fail-on-change` makes the command fail when anything changed, for CI

Exit codes: `0` success · `1` changes found with `--fail-on-change`, or a Real Bug with `--fail-on-bug` · `2` error (bad config or arguments, failed screenshots, missing capture)

## Data Flow (end-to-end)

1. User runs `pixelguard capture --tag current`
2. Capture layer screenshots all configured pages/viewports
3. User runs `pixelguard diff --baseline baseline --current current`
4. Diff layer produces pixel diffs for each page/viewport pair
5. Judge layer scores each diff (Phase 2)
6. Report layer renders the verdict report and saves the run to SQLite
7. _(Phase 3)_ Dashboard reads from SQLite and displays run history + trends

## Configuration

All configuration lives in `.env` (see `.env.example`):

- `TARGET_BASE_URL` — base URL of the app under test (**required**, must start with `http://` or `https://`)
- `TARGET_PAGES` — comma-separated list of page paths to capture
- `VIEWPORTS` — optional override, e.g. `desktop:1440x900,mobile:390x844` (defaults to desktop/tablet/mobile)
- `OUTPUT_DIR` — where screenshots are stored (defaults to `screenshots`)
- `DIFF_DIR` — where diff images are written (defaults to `diffs`)
- `LLM_API_KEY` — API key for the judgment layer's vision LLM calls (not needed for Phase 1)
- `DATABASE_URL` — SQLite location, e.g. `sqlite:./pixelguard.db` (the default). The `sqlite:` prefix is stripped by `sqlitePathFromUrl()` in `config.ts`, and the resulting `Settings.databasePath` is what gets passed to better-sqlite3

`loadSettings()` in `src/config.ts` validates these values and throws a `ConfigError` listing every problem at once, pointing back to `.env.example`.

## Testing the judge

Tests never call a real LLM API (so CI needs no API key and costs nothing):

- `tests/helpers/mockLLM.ts` — a shared `MockLLM` with queued or per-screenshot replies, ready-made realistic replies (`REPLIES`: clean, fenced, with extra text or fields, and several broken ones) and API errors (`ERRORS`)
- `tests/setup/blockLiveLLM.ts` — runs before every test file and blocks any request to `api.anthropic.com`, so an accidental live call fails immediately
- `tests/judgeScenarios.test.ts` — real sample screenshots and the real diff engine and judge, with only the LLM mocked: every verdict, messy-but-valid replies, unreadable replies, API failures, and a mixed multi-page run
