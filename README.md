# pixelguard

**AI-powered visual regression testing agent.** pixelguard captures screenshots of your app before and after a change, diffs them pixel-by-pixel, and then uses a vision-capable LLM to judge whether each detected difference is a _real bug_ or just an _acceptable change_ — solving the classic false-positive problem that makes most visual regression tools painful to use.

> QA Testing track.

---

## Why pixelguard

Traditional visual regression tools flag every pixel difference, no matter how trivial — a date that naturally changed, a slightly different ad banner, anti-aliasing noise. Testers end up drowning in false positives and start ignoring the tool entirely. pixelguard adds a judgment layer on top of the raw diff: it looks at _what_ changed and decides whether a human should actually care.

## What It Does

1. **Captures** screenshots of key pages across multiple viewport sizes, before and after a change
2. **Diffs** each pair pixel-by-pixel, producing a visual diff image and a change percentage
3. **Judges** each diff with a vision-capable LLM — is this a real visual bug, or an acceptable/expected change?
4. **Reports** a clear verdict per page: pass, fail, or needs human review — with an explanation, not just a diff image
5. **Tracks** runs over time via a dashboard, with the ability to accept a new baseline once a change is confirmed intentional

## Project Phases

pixelguard is built in three phases, each ending in something tangible and demoable. See [docs/ROADMAP.md](docs/ROADMAP.md) for the full breakdown and [docs/TICKETS.md](docs/TICKETS.md) for the complete ticket list (50 tickets total).

| Phase                                    | Goal                                  | You end this phase with...                                                                                                                    |
| ---------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1 — Core Capture & Diff Engine** | Capture screenshots and diff them     | Working CLI: `pixelguard capture` + `pixelguard diff` → raw diff images and a JSON/console report of what changed                             |
| **Phase 2 — AI Judgment Layer**          | Separate real bugs from noise         | The same CLI now outputs a **verdict per page** (Real Bug / Acceptable Change / Uncertain) with plain-English reasoning, in a Markdown report |
| **Phase 3 — Dashboard & History**        | Make it demoable and manage baselines | A deployed web dashboard showing run history, a side-by-side diff viewer, trend charts, and a one-click "accept as new baseline" action       |

## Dashboard (Phase 3, in progress)

Every `pixelguard diff` run is saved to `pixelguard.db`. Start the dashboard with:

```bash
npm run pixelguard -- dashboard        # http://127.0.0.1:8100
```

Open it in your browser to see every run — newest first, filterable by status — and click a run to see each page's verdict, the judge's explanation, and the baseline, current and diff screenshots side by side.

## Accepting Intentional Changes

When a diff shows a change you meant to make, make it the new baseline:

```bash
npm run pixelguard -- accept --from current                    # whole capture
npm run pixelguard -- accept --from current --pages /pricing   # just some pages
```

The baseline is swapped in safely (never half-replaced), and a capture with failed screenshots is refused unless you add `--force`. Old baselines are archived, so you can look back or roll back:

```bash
npm run pixelguard -- baseline history      # every version, newest first
npm run pixelguard -- baseline restore 3    # bring version 3 back
```

## Try the Demo

A small demo shop is bundled in [`examples/demo-site/`](examples/demo-site/). One command runs the whole pipeline against it:

```bash
npm run demo
```

It captures the shop, then switches to a new version with two changes — a harmless date update on the home page and a real layout bug on the pricing page (overlapping cards) — captures again, diffs, and writes `demo-output/report.md`. A live clock on every page is marked as an ignored region, so it never counts as a change.

With `LLM_API_KEY` set in `.env`, the AI judge runs too, and should call the date change an **Acceptable Change** and the pricing layout a **Real Bug**. Without a key, you still get the pixel diff and report.

## Tech Stack

- **Screenshot capture:** [Playwright](https://playwright.dev/) (multi-browser, multi-viewport)
- **Pixel diffing:** [pixelmatch](https://github.com/mapbox/pixelmatch)
- **Backend / CLI:** Node.js + TypeScript
- **AI judgment:** Vision-capable LLM API call for verdict + explanation per diff
- **Storage:** SQLite (local, zero-setup) for run history
- **Dashboard:** Lightweight web frontend (Phase 3) served by an Express/Fastify backend
- **CI:** GitHub Actions — lint + test + build on every push/PR

## Quick Start

```bash
# Clone
git clone https://github.com/<your-username>/pixelguard.git
cd pixelguard

# Install
npm install
npx playwright install --with-deps

# Configure
cp .env.example .env
# edit .env with your target URLs and LLM API key

# Capture a baseline, then capture + diff again after a change (Phase 1+)
npm run pixelguard -- capture --tag baseline
npm run pixelguard -- capture --tag current
npm run pixelguard -- diff --baseline baseline --current current --output diffs.json
```

Add `--fail-on-change` to make the diff fail (exit code 1) when anything changed — handy in CI. Add `--change "Redesigned the checkout button"` to say what changed in this build (or set `PIXELGUARD_CHANGE`), which helps the AI judge tell intended changes from regressions. Add `--judge` (with `LLM_API_KEY` set) to get an AI verdict — Real Bug, Acceptable Change or Uncertain — for each changed screenshot, a pass/review/fail result per page, and an overall result like `✗ FAIL: 1 real bug on 1 page, 3 acceptable changes (5 pages checked)`. In CI, use `--judge --fail-on-bug` so only real bugs fail the build. Add `--report report.md` to get a shareable Markdown report with the verdicts, explanations and side-by-side screenshots — see the [sample report](examples/sample-report/report.md).

Full setup instructions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project Structure

```
pixelguard/
├── .github/
│   └── workflows/
│       └── ci.yml            # Lint + test + build pipeline
├── src/
│   ├── capture/               # Playwright screenshot capture
│   ├── diff/                  # Pixel-diffing engine (pixelmatch)
│   ├── judge/                 # AI judgment layer — verdict + explanation per diff
│   ├── report/                # Report generation (console, markdown, JSON) + persistence
│   ├── dashboard/              # Phase 3 — API + web dashboard
│   ├── cli.ts                 # CLI entry point (argument parsing)
│   ├── commands.ts            # capture / diff command logic
│   └── config.ts               # Configuration loading (.env, target profiles)
├── public/                     # Dashboard frontend (plain HTML/CSS/JS, no build step)
├── tests/                      # Unit + integration tests, mirrors src/ layout
│   └── fixtures/diff/          # Sample baseline/current image pairs for diff tests
├── scripts/
│   ├── demo.ts                # npm run demo — full pipeline against the demo site
│   └── generate-diff-fixtures.ts  # Regenerates tests/fixtures/diff (npm run fixtures:diff)
├── docs/
│   ├── ARCHITECTURE.md        # System design, data flow, setup details
│   ├── REPORT_TEMPLATE.md     # Design of the AI-judged Markdown report
│   ├── ROADMAP.md             # Phase breakdown + tangible deliverables
│   └── TICKETS.md             # All 50 tickets, grouped by phase and epic
├── examples/
│   ├── baseline/               # Sample baseline screenshots for testing the diff engine
│   ├── demo-site/              # Demo shop used by npm run demo and the end-to-end test
│   └── sample-report/          # Example Markdown report
├── .env.example
├── pixelguard.regions.example.json  # Example known dynamic regions (copy to pixelguard.regions.json)
├── .gitignore
├── eslint.config.js           # ESLint 9 flat config
├── package.json
├── package-lock.json
├── tsconfig.json              # Type-checking config (src + tests)
├── tsconfig.build.json        # Build config (src → dist)
├── CONTRIBUTING.md
└── LICENSE
```

## License

MIT — see [LICENSE](LICENSE).
