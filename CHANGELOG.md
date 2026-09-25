# Changelog

## 1.0.0 (2026-09-25)

The first complete release: all 50 tickets across the three phases are done. Everything below is new.

### Phase 1: capture and diff

- `pixelguard capture --tag <name>`: full-page screenshots of every page in `TARGET_PAGES` at every viewport (desktop, tablet and mobile by default) with Playwright and Chromium. It waits for pages to settle, keeps going when single screenshots fail, and never replaces a good capture with a completely failed one.
- `pixelguard diff`: pixel comparison with pixelmatch. It writes diff images, counts changed pixels and the percentage changed, and handles pages that changed size.
- Console table and JSON output (`--output`), a colour sensitivity setting (`--threshold`) and `--fail-on-change` for CI.
- Settings from `.env`, validated up front with every problem reported at once.

### Phase 2: the AI judge

- `diff --judge`: each changed screenshot goes to a vision model (Anthropic, `claude-sonnet-5` by default) for a verdict of Real Bug, Acceptable Change or Uncertain, with a confidence score, an explanation and what it saw. Only changed screenshots are sent, cropped to what changed. Calls are retried with backoff.
- Change context: `--change`, `--change-file` or `PIXELGUARD_CHANGE` say what the build was meant to change. Known dynamic regions in `pixelguard.regions.json` are either masked out or explained to the judge.
- Results per page (pass, review or fail) and per run, with `--fail-on-bug` so only real bugs fail a build.
- Markdown reports (`--report`) with verdicts, explanations and screenshots side by side.
- Every run is saved to SQLite (`DATABASE_URL`), with automatic schema upgrades.

### Phase 3: dashboard and history

- `pixelguard dashboard`, a web dashboard with no build step:
  - **Runs:** history of every run, filterable by status.
  - **Run page:** a side-by-side baseline, current and diff viewer with the judge's reasoning.
  - **Trend:** regressions over time.
  - **Baselines:** version history.
  - Light and dark themes.
- Accepting changes as the new baseline, from the dashboard (whole run or page by page) or with `pixelguard accept`. Swaps are safe and every version is kept: `pixelguard baseline history` and `baseline restore`.
- A JSON API behind the dashboard (`/api/runs`, `/api/runs/trend`, `/api/baselines/…`) with security headers, and same-origin checks on actions.
- A read-only mode (`--read-only` or `DASHBOARD_READ_ONLY=true`) for sharing with a team.
- A Dockerfile and `docker-compose.yml` (app and Chromium), plus [a deployment guide](docs/DEPLOYMENT.md).
- `npm run demo` (with `--step`, `--dashboard` and `--scripted-judge`), `npm run demo:site` and [a presenter's guide](docs/DEMO.md).

### Quality

- Unit, API, browser (real Chromium) and end-to-end tests, including a full lifecycle test through all three phases (`tests/lifecycle.test.ts`). CI runs lint, a format check, type checks, tests with coverage, and the build.
