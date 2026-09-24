# Roadmap

pixelguard is built in three phases. Each phase ends with something tangible you can actually run and demo — not just a partial pile of code. Full ticket-level breakdown is in [TICKETS.md](TICKETS.md).

---

## Phase 1 — Core Capture & Diff Engine (17 tickets)

**Goal:** Capture real screenshots and get a working pixel-diff pipeline running end-to-end.

**You end this phase with:**
A working CLI — `pixelguard capture` and `pixelguard diff` — that screenshots a real target app across multiple viewports, diffs a baseline against a current run, and outputs raw diff results (diff images, pixel counts, percentage changed) to console and JSON.

**Epics covered:**
- Project setup & tooling
- Screenshot capture (Playwright, multi-viewport, multi-page)
- Diff engine (pixelmatch integration)
- Basic CLI + raw report output
- Phase 1 tests + demo readiness

---

## Phase 2 — AI Judgment Layer (17 tickets)

**Goal:** Turn raw pixel diffs into a clear, explained verdict per page.

**You end this phase with:**
The same CLI now runs the full pipeline: capture → diff → **AI-judged verdict** (Real Bug / Acceptable Change / Uncertain) → a clean Markdown report explaining each verdict — plus run results saved to a local database.

**Epics covered:**
- Change-context configuration (known dynamic regions, expected changes)
- Vision LLM judgment integration
- Verdict aggregation (per-page and per-run summaries)
- Markdown report generation
- Run persistence (SQLite)
- Phase 2 tests + demo readiness

---

## Phase 3 — Dashboard & History (16 tickets)

**Goal:** Make pixelguard demoable as a real tool, with baseline management and run history.

**You end this phase with:**
A deployed (or locally runnable) web dashboard showing past runs, a side-by-side diff viewer per page, a trend view of regressions over time, and a one-click way to accept a confirmed change as the new baseline. This is the portfolio-ready version.

**Epics covered:**
- FastAPI-equivalent (Express/Fastify) backend routes for run history
- Dashboard frontend (run list, diff viewer, trend chart)
- Baseline management (accept new baseline, baseline versioning)
- Deployment (Docker Compose or a simple hosted deploy)
- Documentation polish + demo script
- Phase 3 tests + final demo readiness

---

## After Phase 3 (optional, not scoped into the 50 tickets)

- Cross-browser diffing (Chromium vs. Firefox vs. WebKit rendering differences)
- CI integration — run pixelguard automatically on every PR, comment with diff summary
- Component-level diffing (isolated UI components, not just full pages)
- Multi-project support in a single dashboard
