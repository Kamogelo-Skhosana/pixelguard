# Tickets

50 tickets across 3 phases. Copy these into GitHub Issues (one issue per ticket) or a GitHub Project board — the IDs (P001, P002...) are meant to match your issue numbers or be used as labels for traceability.

Suggested labels: `phase-1`, `phase-2`, `phase-3`, plus an epic label per group (e.g., `epic:diff-engine`).

---

## Phase 1 — Core Capture & Diff Engine (17 tickets)

**End state:** `pixelguard capture` + `pixelguard diff` run against a real target and output raw diff results to console + JSON.

### Epic: Project Setup & Tooling

- [x] **P001** — Initialize repo: folder structure, `.gitignore`, `LICENSE` (MIT)
- [x] **P002** — Set up Node/TypeScript project (`package.json`, `tsconfig.json`), document install in README
- [x] **P003** — Add ESLint + Prettier config
- [x] **P004** — Set up test framework scaffold (Vitest), `tests/` structure
- [x] **P005** — Add GitHub Actions CI workflow: install deps, lint, test, build on push/PR

### Epic: Screenshot Capture

- [x] **P006** — Add Playwright browser wrapper (`capture/browser.ts`) — launch, navigate, close
- [x] **P007** — Implement full-page screenshot capture for a given URL
- [x] **P008** — Implement capture across multiple viewport sizes (desktop/tablet/mobile)
- [x] **P009** — Implement capturing multiple named pages/routes in a single run
- [x] **P010** — Add baseline vs. current screenshot storage convention (tagged folders)
- [x] **P011** — Add config loading (target base URL, pages list, viewports, output dir)

### Epic: Diff Engine

- [x] **P012** — Integrate `pixelmatch` for pixel-level image diffing
- [x] **P013** — Implement `DiffResult` model (pixel diff count, percent changed, diff image path)
- [ ] **P014** — Add unit tests for the diff engine using sample image pairs

### Epic: CLI & Raw Report Output

- [ ] **P015** — Build CLI entry point: `pixelguard capture` and `pixelguard diff` commands
- [ ] **P016** — Implement console output formatter for diff summaries
- [ ] **P017** — Implement JSON export of diff results (`--output diffs.json`)

**Phase 1 checkpoint:** Capture a baseline of a real site, make a small visible change, capture again, and confirm `pixelguard diff` correctly flags the changed pages with a diff image and percentage.

---

## Phase 2 — AI Judgment Layer (17 tickets)

**End state:** The same CLI produces a per-page verdict (Real Bug / Acceptable Change / Uncertain) with explanations, in a Markdown report, and runs are saved locally.

### Epic: Change Context Configuration

- [ ] **P018** — Design change-context schema: known dynamic regions (timestamps, ads, carousels) to weight/exclude
- [ ] **P019** — Add config for marking known-dynamic regions per page
- [ ] **P020** — Add a CLI option to supply a short description of what changed in this build (helps the LLM's judgment)

### Epic: LLM Judgment Integration

- [ ] **P021** — Design the judgment prompt template: diff image + context in, structured verdict out
- [ ] **P022** — Build vision-capable LLM client wrapper (API key config, retries)
- [ ] **P023** — Implement the judgment call per diff and parse the structured response
- [ ] **P024** — Extend `DiffResult` with verdict, confidence score, and explanation fields
- [ ] **P025** — Add unit tests using mocked LLM responses (no live API calls in CI)

### Epic: Verdict Aggregation

- [ ] **P026** — Implement per-page verdict rollup (does this page pass or fail overall?)
- [ ] **P027** — Implement run-level summary (X real bugs, Y acceptable changes, Z uncertain)
- [ ] **P028** — Add tests covering aggregation edge cases (mixed verdicts on one page, all-uncertain runs)

### Epic: Report Generation

- [ ] **P029** — Design the Markdown report template (verdicts, diff image links, explanations)
- [ ] **P030** — Implement the Markdown report generator
- [ ] **P031** — Add a CLI flag to write the Markdown report to file (`--report report.md`)

### Epic: Persistence

- [ ] **P032** — Set up SQLite schema: `runs` table, `page_diffs` table
- [ ] **P033** — Implement save-run-to-database logic after each run

### Epic: Phase 2 Wrap-up

- [ ] **P034** — End-to-end test: full pipeline (capture → diff → AI judgment → Markdown report) + demo readiness pass

**Phase 2 checkpoint:** Run the full pipeline against the same test target with an intentional trivial change (e.g., a date) and an intentional real bug (e.g., a broken layout) — confirm the verdicts correctly tell them apart.

---

## Phase 3 — Dashboard & History (16 tickets)

**End state:** A working web dashboard showing run history, a diff viewer, trend charts, and baseline management.

### Epic: Backend API

- [ ] **P035** — Set up Express/Fastify API skeleton, served alongside the existing CLI
- [ ] **P036** — Implement `GET /runs` — list run history
- [ ] **P037** — Implement `GET /runs/:id` — page diffs detail for one run
- [ ] **P038** — Implement `GET /runs/trend` — regression rate over time

### Epic: Dashboard Frontend

- [ ] **P039** — Build run list page (table: date, target, pass/fail summary)
- [ ] **P040** — Build run detail page (side-by-side baseline/current/diff viewer per page)
- [ ] **P041** — Build a trend chart view (regressions found over time)
- [ ] **P042** — Add basic styling/theme to the dashboard
- [ ] **P043** — Wire the frontend to the backend API endpoints

### Epic: Baseline Management

- [ ] **P044** — Implement "accept as new baseline" action (promote current screenshots to baseline)
- [ ] **P045** — Add baseline versioning/history so accepted baselines can be reviewed later

### Epic: Deployment

- [ ] **P046** — Write `Dockerfile` + `docker-compose.yml` (app + Playwright browsers)
- [ ] **P047** — Deploy the dashboard (or fully document local-run steps if hosted deploy is out of scope)

### Epic: Docs & Final Demo Readiness

- [ ] **P048** — Polish full usage docs in the README (setup, screenshots, example output)
- [ ] **P049** — Prepare a demo script / sample site walkthrough for presenting the project
- [ ] **P050** — Final end-to-end test pass across all three phases; tag `v1.0` release

**Phase 3 checkpoint:** Open the dashboard, see real run history with a diff viewer and trend chart, and successfully accept a new baseline through the UI — this is the version you show in your portfolio or an interview.

---

## Ticket Summary

| Phase                                | Tickets | Range     |
| ------------------------------------ | ------- | --------- |
| Phase 1 — Core Capture & Diff Engine | 17      | P001–P017 |
| Phase 2 — AI Judgment Layer          | 17      | P018–P034 |
| Phase 3 — Dashboard & History        | 16      | P035–P050 |
| **Total**                            | **50**  |           |
