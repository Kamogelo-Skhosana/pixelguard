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
- Findings are rolled up per page and per run into a pass/fail/review summary

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

- Console output (Phase 1) and Markdown report (Phase 2) rendering
- SQLite persistence of every run's results (Phase 2+)
- Phase 3 dashboard: run history, side-by-side diff viewer, trend chart, and "accept as new baseline" action

## CLI

```bash
pixelguard capture --tag <name>
pixelguard diff --baseline <tag> --current <tag> [--output diffs.json] [--threshold 0.1] [--fail-on-change]
```

- `capture` screenshots every page in `TARGET_PAGES` at every viewport into `screenshots/<tag>/`
- `diff` pairs the two captures using their manifests, writes diff images to `diffs/<baseline>-vs-<current>/<viewport>/<page>.png`, prints a table, and lists anything it couldn't compare (new, removed or failed pages)
- `--change "<text>"` (or `--change-file notes.txt`, or the `PIXELGUARD_CHANGE` environment variable in CI) describes what changed in this build; it's shown in the output, saved in the JSON report, and given to the AI judge in Phase 2. Max 1000 characters; an explicit `--change-file` wins over `PIXELGUARD_CHANGE`
- `--output` also writes the results as JSON; `--threshold` sets pixel colour sensitivity (0-1); `--fail-on-change` makes the command fail when anything changed, for CI

Exit codes: `0` success · `1` changes found with `--fail-on-change` · `2` error (bad config or arguments, failed screenshots, missing capture)

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
