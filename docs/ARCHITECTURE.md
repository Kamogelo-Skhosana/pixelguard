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

## Dashboard server (Phase 3)

- Start it with `npm run pixelguard -- dashboard` (or `npm run dev:dashboard`); `--port` / `--host` override `DASHBOARD_PORT` (default `8100`) and `DASHBOARD_HOST` (default `127.0.0.1`, so only this computer can reach it — use `0.0.0.0` in Docker or to share it on your network). Ctrl+C stops it cleanly
- `src/dashboard/app.ts` — `createApp({ db })` builds the Express app; it takes an open database so tests can use an in-memory one
- `GET /api/health` → `{ status, version, schemaVersion, runs }`
- `GET /api/runs` (P036) — run history, newest first: `{ runs, total, limit, offset }`. Each run is a camelCase summary (tags, target, status, headline, judge model, page counts, screenshot counts, verdict counts, report/JSON paths) — the frontend never sees SQLite column names. Query parameters: `limit` (1–200, default 50), `offset`, `status` (`pass` / `review` / `fail`) and `target` (exact target URL). Invalid or unknown parameters get a 400 listing the problems
- `GET /api/runs/:id` (P037) — one run: `{ run, pages }`. `run` is the same summary as in the list. `pages` are rebuilt with the same `rollupPages()` the CLI and Markdown report use, so statuses and summaries match exactly; each page lists its screenshots with pixel numbers, sizes, verdict, confidence, explanation, observed changes, regions, skip reason and image URLs. Unknown runs get a 404; ids that aren't positive whole numbers get a 400
- `GET /api/runs/:id/diffs/:diffId/:kind` (P037) — serves a screenshot's `baseline`, `current` or `diff` PNG. It only serves the file recorded in the database for that exact screenshot of that run (never an arbitrary path), only `.png` files, and returns a clear 404 if the file has since been cleaned up. Stored paths are resolved against the project folder
- `GET /api/runs/trend` (P038) — regression trend: `{ period, from, to, points, totals }`. **Regression rate** = pages that failed ÷ pages checked (0–1); each point also has the failed-run rate and counts of runs, pages checked/failed/review, real bugs, acceptable changes and uncertain. Query: `period` = `day` (default), `week` (Monday-start) or `run` (one point per run); `days` = window size (1–365, default 30); `target`. Day and week periods include empty buckets with `runs: 0` and `null` rates (not 0), so charts show gaps honestly instead of implying nothing broke
- **Frontend (P039):** plain HTML, CSS and JavaScript modules in `public/`, served by the same Express app — no build step, so it works identically from `src/` (tsx) and `dist/`. A small hash router (`public/js/app.js`) keeps the view in the URL (`#/runs?status=fail&page=2`), so reload and the back button work. All data is inserted with `textContent` (never `innerHTML`), so page names, notes and URLs from runs can't inject HTML
  - **Run list (`#/runs`):** newest first, 25 per page, with run number, time (relative and local), target, the tags compared, a status badge, the run summary and developer note, page counts, and the judge model; filter by status; empty, loading and error states. Clicking a row opens the run
  - **Run detail (`#/runs/:id`, P040):** the run's status, summary, target, tags, time, judge model and developer note, then every page worst first — failing and review pages open, passing pages collapsed. Each changed or skipped screenshot gets a card with its verdict and confidence, % and pixels changed, size change, ignored/expected regions, the judge's explanation and what it saw, and **Baseline / Current / Diff images side by side** (each opens full size). Unchanged viewports are listed on one line; images that were cleaned up show a placeholder; unknown runs get a "not found" message
  - **Trend (`#/trend?period=day&days=30`, P041):** "Regressions over time" from `GET /api/runs/trend`. Totals tiles (runs, pages failing, needs review, real bugs, regression rate), then a hand-drawn SVG bar chart (no chart library): failing pages stacked under needs-review pages per day, week or run, a green mark for periods where every run passed, a dot where the judge found a Real Bug, and gaps for periods with no runs. Hovering or focusing a bar describes it; per-run bars open that run. The same numbers are available as a table. Chart maths lives in `public/js/chart.js` (pure functions, unit-tested); on narrow screens the chart scrolls sideways
  - **Theme (P042):** one stylesheet (`public/css/styles.css`) built on colour, type and spacing tokens on `:root`. The look borrows from print proofing: a registration-mark logo, process magenta (the colour pixelguard paints differences in) as the single accent, and screenshots framed on a faint checkerboard like proofs on a light table. Status colours (red failing, amber needs review, green passing) are the same in badges, page borders and the trend chart. Dark mode follows the system setting; the top-bar button switches between auto, light and dark and remembers the choice in `localStorage` (`public/js/theme.js`, loaded in `<head>` so there's no flash of the wrong theme). Keyboard focus is always visible and reduced-motion is respected. No web fonts are downloaded, so the dashboard works offline and under the strict CSP
  - The router counts finished renders (`body[data-renders]`), which the browser tests use to wait for the next render without races
- Every response carries security headers: a strict Content-Security-Policy (only the dashboard's own scripts, styles and images), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`
- Unknown `/api` routes return a JSON 404; route errors are logged on the server and returned as a generic JSON 500 (no internal details); the `X-Powered-By` header is off
- A port that's already in use gives a clear error (exit code 2)

## Baseline management (P044)

When a change is intentional, accept it so future runs compare against it:

```bash
pixelguard accept --from current                      # the whole capture becomes the baseline
pixelguard accept --from current --pages /pricing     # only some pages; the rest of the baseline is kept
```

- `acceptAsBaseline()` (`src/dashboard/baselineManager.ts`) builds the new baseline in a temporary folder and swaps it in at the end, so a failure never leaves a half-replaced baseline (the old one is put back). The accepted manifest records `promotedFrom` (tag, time, and pages for a partial accept)
- A whole accept also drops baseline pages that aren't in the capture; a page accept replaces just those pages' files (and adds pages the baseline didn't have)
- Refuses — without changing anything — a capture with failed screenshots (unless `--force`, which leaves those out), unknown pages, a tag accepted as itself, or a page accept when there's no baseline yet
- Dashboard: `POST /api/runs/:id/accept` with `{ "pages"?: [...], "force"?: bool }` accepts that run's current capture into its baseline tag. Because it changes files, it only accepts JSON (so a plain HTML form on another site can't submit it) from the dashboard's own origin (`Origin` / `Sec-Fetch-Site` checked), and it refuses with a 409 if the current tag was re-captured after that run — so you can never accept screenshots you weren't shown

## Baseline history (P045)

Replaced baselines are archived, not deleted, so they can be reviewed or restored:

```
screenshots/_history/baseline/history.json   every version: when, and how it was made
screenshots/_history/baseline/v1/            the baseline as it was at version 1
screenshots/_history/baseline/v2/            ...
```

- Version 1 is the original captured baseline; every accept or restore creates the next version. The live baseline is always the latest version and stays in `screenshots/baseline/`
- `pixelguard baseline history` lists versions (newest first) with how each was made; `pixelguard baseline restore <version>` brings one back. A restore archives the baseline it replaces and is recorded as a new version, so it can be undone too
- Only the newest 20 archives are kept (`keepVersions`); older entries stay in the history list, marked as no longer archived
- `_history` can't be a tag name, so it never shows up as a capture
- API: `GET /api/baselines/:tag/history`, `GET /api/baselines/:tag/versions/:version` (pages and image URLs), `GET /api/baselines/:tag/versions/:version/images/:viewport/:page` (only images listed in that version's manifest), and `POST /api/baselines/:tag/restore` `{ "version": n }` (JSON and same-origin only, like accept)

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
- `DASHBOARD_HOST` / `DASHBOARD_PORT` — where the dashboard listens (defaults `127.0.0.1` and `8100`)
- `DATABASE_URL` — SQLite location, e.g. `sqlite:./pixelguard.db` (the default). The `sqlite:` prefix is stripped by `sqlitePathFromUrl()` in `config.ts`, and the resulting `Settings.databasePath` is what gets passed to better-sqlite3

`loadSettings()` in `src/config.ts` validates these values and throws a `ConfigError` listing every problem at once, pointing back to `.env.example`.

## Testing the judge

Tests never call a real LLM API (so CI needs no API key and costs nothing):

- `tests/helpers/mockLLM.ts` — a shared `MockLLM` with queued or per-screenshot replies, ready-made realistic replies (`REPLIES`: clean, fenced, with extra text or fields, and several broken ones) and API errors (`ERRORS`)
- `tests/setup/blockLiveLLM.ts` — runs before every test file and blocks any request to `api.anthropic.com`, so an accidental live call fails immediately
- `tests/judgeScenarios.test.ts` — real sample screenshots and the real diff engine and judge, with only the LLM mocked: every verdict, messy-but-valid replies, unreadable replies, API failures, and a mixed multi-page run

## End-to-end test and demo (P034)

- `examples/demo-site/` is a small demo shop with two versions: version 2 changes the home page's "last updated" date (harmless) and breaks the pricing layout (overlapping cards). Every page shows a live clock, which `examples/demo-site/pixelguard.regions.json` marks as an ignored region
- `tests/e2e.test.ts` runs the real CLI against it — capture, site change, capture, diff, judge, report, JSON and database — with only the LLM mocked. It checks that exactly the changed pages are flagged (the clock is ignored), only changed screenshots reach the judge, pages roll up correctly, `--fail-on-bug` fails the run, the report's images exist, and the database matches the JSON
- `npm run demo` runs the same flow with the real model (when `LLM_API_KEY` is set) — the Phase 2 checkpoint: the judge should call the date change acceptable and the pricing layout a real bug. Output goes to `demo-output/` (git-ignored)
