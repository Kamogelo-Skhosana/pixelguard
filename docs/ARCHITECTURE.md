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
- Saves screenshots into a tagged folder (e.g., `screenshots/baseline/`, `screenshots/current/`)

```
screenshots/
├── baseline/
│   ├── desktop/home.png
│   └── mobile/home.png
└── current/
    ├── desktop/home.png
    └── mobile/home.png
```

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
  "percentChanged": 1.3,
  "diffImagePath": "diffs/home-desktop.png",
  "baselineImagePath": "screenshots/baseline/desktop/home.png",
  "currentImagePath": "screenshots/current/desktop/home.png"
}
```

## 3. Judge Layer (`src/judge/`, Phase 2)

- Takes each `DiffResult` (plus the baseline/current image pair and any configured "known dynamic regions")
- Sends **all three images** (baseline, current, and diff) to a vision-capable LLM with a structured prompt — the diff image alone only shows _where_ pixels changed, while the baseline/current pair shows _what_ changed
- LLM returns:
  - **Verdict:** Real Bug / Acceptable Change / Uncertain
  - **Confidence** (1–10)
  - **Explanation** in plain English
- Findings are rolled up per page and per run into a pass/fail/review summary

## 4. Report + Dashboard (`src/report/`, `src/dashboard/`)

- Console output (Phase 1) and Markdown report (Phase 2) rendering
- SQLite persistence of every run's results (Phase 2+)
- Phase 3 dashboard: run history, side-by-side diff viewer, trend chart, and "accept as new baseline" action

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

- `TARGET_BASE_URL` — base URL of the app under test
- `TARGET_PAGES` — comma-separated list of page paths to capture
- `OUTPUT_DIR` — where screenshots are stored (defaults to `screenshots`)
- `LLM_API_KEY` — API key for the judgment layer's vision LLM calls
- `DATABASE_URL` — SQLite location, e.g. `sqlite:./pixelguard.db` (the default). The `sqlite:` prefix is stripped by `sqlitePathFromUrl()` in `config.ts`, and the resulting `Settings.databasePath` is what gets passed to better-sqlite3
