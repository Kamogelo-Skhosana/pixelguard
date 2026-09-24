# Contributing

This is a personal portfolio project, built ticket-by-ticket across three phases. See [docs/ROADMAP.md](docs/ROADMAP.md) for the phase overview and [docs/TICKETS.md](docs/TICKETS.md) for the full list of 50 tickets.

## Workflow

1. Pick the next open ticket from `docs/TICKETS.md` (work roughly in order within a phase — later tickets often depend on earlier ones).
2. Create a branch: `git checkout -b P0XX-short-description`
3. Implement the ticket, replacing the relevant `TODO` / `throw new Error("Not implemented")` in the code.
4. Add/update tests for the ticket's scope.
5. Run locally before pushing:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
6. Open a PR referencing the ticket ID (e.g., `Implements P013 — DiffResult model`).
7. Check the box for that ticket in `docs/TICKETS.md` once merged.

## Code Style

- Linted with ESLint, formatted per the shared config
- TypeScript `strict` mode is on — no implicit `any`
- Every module has a header comment stating which ticket(s) it belongs to (keeps traceability between code and the ticket list)
