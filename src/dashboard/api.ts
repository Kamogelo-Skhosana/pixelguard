/**
 * Express API routes for the pixelguard dashboard.
 *
 * Mounted at /api by createApp() (app.ts). Each route reads from the
 * database passed in.
 *
 * Tickets: P035, P036, P037, P038
 */

import express from "express";
import type Database from "better-sqlite3";

export function createApiRouter(_db: Database.Database): express.Router {
  const router = express.Router();

  router.get("/runs", (_req, res) => {
    // TODO (P036): query the runs table, return summary rows
    // (id, target_url, date, pass/fail summary).
    res.status(501).json({ error: "Not implemented" });
  });

  // NOTE: /runs/trend must be registered before /runs/:id, otherwise
  // Express matches "trend" as an :id value.
  router.get("/runs/trend", (_req, res) => {
    // TODO (P038): aggregate regression counts per run date for a
    // trend chart.
    res.status(501).json({ error: "Not implemented" });
  });

  router.get("/runs/:id", (_req, res) => {
    // TODO (P037): query page_diffs for the given run id, return
    // the full verdict list.
    res.status(501).json({ error: "Not implemented" });
  });

  return router;
}
