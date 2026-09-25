/**
 * The dashboard's Express app (Phase 3).
 *
 *   GET /api/health   -> { status, version, schemaVersion, runs }
 *   /api/runs...      -> run history endpoints (P036-P038)
 *
 * Unknown /api routes get a JSON 404 and errors a JSON 500, so the
 * frontend (P039+) always receives JSON from /api. The app takes an open
 * database, so tests can use an in-memory one.
 *
 * Ticket: P035
 */

import express, { type ErrorRequestHandler, type Express } from "express";
import type Database from "better-sqlite3";
import { schemaVersion } from "../report/persistence.js";
import { createApiRouter } from "./api.js";

export const PIXELGUARD_VERSION = "0.1.0";

export interface AppOptions {
  db: Database.Database;
  /** Folder stored image paths are relative to (default: the current folder). */
  projectDir?: string;
}

export function createApp({ db, projectDir = process.cwd() }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    res.json({
      status: "ok",
      version: PIXELGUARD_VERSION,
      schemaVersion: schemaVersion(db),
      runs: n,
    });
  });

  app.use("/api", createApiRouter(db, { projectDir }));

  // Anything else under /api that no route handled.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: `No API endpoint for ${req.method} ${req.originalUrl}` });
  });

  // Errors thrown in routes: log them, and send JSON without internal details.
  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === "number" && err.status >= 400 ? err.status : 500;
    if (status >= 500) console.error(`[pixelguard] ${req.method} ${req.originalUrl} failed:`, err);
    res.status(status).json({
      error: status >= 500 ? "Something went wrong on the server" : String(err.message ?? err),
    });
  };
  app.use(onError);

  return app;
}
