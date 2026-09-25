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
import { z } from "zod";
import { listRuns } from "./queries.js";

/** Query string for GET /api/runs. */
const RunListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(["pass", "review", "fail"]).optional(),
    target: z.string().trim().min(1).optional(),
  })
  .strict();

/** Turns zod issues into short "field: problem" strings for 400 responses. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) =>
    i.code === "unrecognized_keys"
      ? `unknown parameter(s): ${i.keys.join(", ")}`
      : `${i.path.join(".") || "query"}: ${i.message}`
  );
}

export function createApiRouter(db: Database.Database): express.Router {
  const router = express.Router();

  // GET /api/runs?limit=50&offset=0&status=fail&target=https://example.com  (P036)
  router.get("/runs", (req, res) => {
    const query = RunListQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query", issues: describeIssues(query.error) });
      return;
    }
    const { limit, offset, status, target } = query.data;
    res.json(listRuns(db, { limit, offset, status, targetUrl: target }));
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
