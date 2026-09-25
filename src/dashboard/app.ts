/**
 * The dashboard's Express app (Phase 3).
 *
 *   GET /             -> the dashboard frontend (public/, P039+)
 *   GET /api/health   -> { status, version, schemaVersion, runs, readOnly }
 *   /api/runs...      -> run history endpoints (P036-P038)
 *
 * Unknown /api routes get a JSON 404 and errors a JSON 500, so the
 * frontend (P039+) always receives JSON from /api. The app takes an open
 * database, so tests can use an in-memory one.
 *
 * Ticket: P035
 */

import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import type Database from "better-sqlite3";
import { schemaVersion } from "../report/persistence.js";
import { createApiRouter } from "./api.js";

// Defined in package.json (P050); re-exported for existing imports.
import { PIXELGUARD_VERSION } from "../version.js";
export { PIXELGUARD_VERSION };

export interface AppOptions {
  db: Database.Database;
  /** Folder stored image paths are relative to (default: the current folder). */
  projectDir?: string;
  /** Current time, for the trend window (tests pass a fixed date). */
  now?: () => Date;
  /** Root screenshots folder, for accepting baselines (default: "screenshots"). */
  outputDir?: string;
  /** When true, accepting and restoring baselines is refused (P047). */
  readOnly?: boolean;
}

/**
 * The frontend's folder. Resolved from this file so it works both from src/
 * (tsx) and from the built dist/ — both are two levels below the project root.
 */
export const publicDir = fileURLToPath(new URL("../../public", import.meta.url));

/** Security headers for every response: the dashboard only loads its own files. */
const securityHeaders: express.RequestHandler = (_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  next();
};

export function createApp({
  db,
  projectDir = process.cwd(),
  now,
  outputDir = "screenshots",
  readOnly = false,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    res.json({
      status: "ok",
      version: PIXELGUARD_VERSION,
      schemaVersion: schemaVersion(db),
      runs: n,
      // Lets the frontend hide the accept/restore buttons (P047).
      readOnly,
    });
  });

  app.use("/api", createApiRouter(db, { projectDir, now, outputDir, readOnly }));

  // Anything else under /api that no route handled.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: `No API endpoint for ${req.method} ${req.originalUrl}` });
  });

  // The frontend (P039+): plain HTML/CSS/JS modules from public/, no build step.
  app.use(express.static(publicDir, { index: "index.html", fallthrough: true, maxAge: 0 }));

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
