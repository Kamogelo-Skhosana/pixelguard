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
import { existsSync } from "node:fs";
import { readManifest } from "../capture/storage.js";
import type { RunRow } from "../report/persistence.js";
import { acceptAsBaseline, AcceptError } from "./baselineManager.js";
import { resolve } from "node:path";
import {
  getImagePath,
  getRunDetail,
  getTrend,
  IMAGE_KINDS,
  listRuns,
  type ImageKind,
} from "./queries.js";

/** Query string for GET /api/runs. */
const RunListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(["pass", "review", "fail"]).optional(),
    target: z.string().trim().min(1).optional(),
  })
  .strict();

/** Query string for GET /api/runs/trend. */
const TrendQuery = z
  .object({
    period: z.enum(["day", "week", "run"]).default("day"),
    days: z.coerce.number().int().min(1).max(365).default(30),
    target: z.string().trim().min(1).optional(),
  })
  .strict();

/** Body for POST /api/runs/:id/accept. */
const AcceptBody = z
  .object({
    pages: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
    force: z.boolean().optional(),
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

const PositiveId = z.coerce.number().int().positive();

export interface ApiOptions {
  /** Folder stored image paths are relative to (the project folder; default: cwd). */
  projectDir: string;
  /** Current time, for the trend window (tests pass a fixed date). */
  now?: () => Date;
  /** Root screenshots folder (Settings.outputDir), for accepting baselines. */
  outputDir: string;
}

export function createApiRouter(
  db: Database.Database,
  options: ApiOptions = { projectDir: process.cwd(), outputDir: "screenshots" }
): express.Router {
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
  router.get("/runs/trend", (req, res) => {
    // GET /api/runs/trend?period=day&days=30&target=...  (P038)
    const query = TrendQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query", issues: describeIssues(query.error) });
      return;
    }
    const { period, days, target } = query.data;
    res.json(getTrend(db, { period, days, targetUrl: target, now: options.now?.() ?? new Date() }));
  });

  // GET /api/runs/:id  (P037) — one run with its pages and screenshots.
  router.get("/runs/:id", (req, res) => {
    const id = PositiveId.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Run id must be a positive whole number" });
      return;
    }
    const detail = getRunDetail(db, id.data);
    if (!detail) {
      res.status(404).json({ error: `Run ${id.data} not found` });
      return;
    }
    res.json(detail);
  });

  // GET /api/runs/:id/diffs/:diffId/:kind  (P037) — a screenshot image.
  // Only serves the files recorded for that exact screenshot in the database,
  // so arbitrary paths can never be requested.
  router.get("/runs/:id/diffs/:diffId/:kind", (req, res, next) => {
    const runId = PositiveId.safeParse(req.params.id);
    const diffId = PositiveId.safeParse(req.params.diffId);
    const kind = z.enum(IMAGE_KINDS as [ImageKind, ...ImageKind[]]).safeParse(req.params.kind);
    if (!runId.success || !diffId.success || !kind.success) {
      res.status(400).json({ error: "Expected /runs/<id>/diffs/<id>/(baseline|current|diff)" });
      return;
    }
    const stored = getImagePath(db, runId.data, diffId.data, kind.data);
    if (!stored || !stored.toLowerCase().endsWith(".png")) {
      res.status(404).json({ error: "No such image" });
      return;
    }
    const file = resolve(options.projectDir, stored);
    if (!existsSync(file)) {
      res
        .status(404)
        .json({ error: "The image file no longer exists (it may have been cleaned up)" });
      return;
    }
    res.type("png").set("Cache-Control", "no-cache");
    res.sendFile(file, (err) => err && next(err));
  });

  // POST /api/runs/:id/accept  { "pages"?: ["pricing"] }  (P044)
  // Promotes the run's current capture to be the new baseline. This changes
  // files on disk, so it only accepts JSON from the dashboard's own origin
  // (a form or script on another website can't trigger it).
  router.post("/runs/:id/accept", async (req, res, next) => {
    try {
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Send a JSON body (Content-Type: application/json)" });
        return;
      }
      if (!sameOrigin(req)) {
        res
          .status(403)
          .json({ error: "Accepting a baseline is only allowed from the dashboard itself" });
        return;
      }
      const id = PositiveId.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Run id must be a positive whole number" });
        return;
      }
      const body = AcceptBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "Invalid body", issues: describeIssues(body.error) });
        return;
      }

      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id.data) as RunRow | undefined;
      if (!run) {
        res.status(404).json({ error: `Run ${id.data} not found` });
        return;
      }

      // Refuse if the current tag was re-captured after this run: accepting
      // would promote screenshots the user never saw in this run.
      const current = await readManifest(options.outputDir, run.current_tag).catch(() => null);
      if (!current) {
        res.status(409).json({
          error: `The "${run.current_tag}" capture from this run no longer exists, so it can't be accepted.`,
        });
        return;
      }
      if (current.capturedAt > run.created_at) {
        res.status(409).json({
          error:
            `"${run.current_tag}" has been re-captured since run ${run.id}, so its screenshots are ` +
            `no longer the ones shown here. Run pixelguard diff again, then accept the new run.`,
        });
        return;
      }

      const accepted = await acceptAsBaseline({
        outputDir: options.outputDir,
        fromTag: run.current_tag,
        toTag: run.baseline_tag,
        pages: body.data.pages,
        force: body.data.force,
      });
      res.json({ accepted });
    } catch (err) {
      if (err instanceof AcceptError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

/**
 * True when the request comes from the dashboard's own page. Browsers send
 * Origin (and Sec-Fetch-Site) on cross-site POSTs; requests without them
 * (curl, scripts on this machine) are allowed.
 */
function sameOrigin(req: express.Request): boolean {
  if (req.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}
