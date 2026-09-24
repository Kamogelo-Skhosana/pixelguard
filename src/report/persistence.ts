/**
 * SQLite persistence for runs and page diffs.
 *
 * Tickets: P032, P033
 */

import Database from "better-sqlite3";

/**
 * @param _databasePath Plain SQLite file path (e.g. "./pixelguard.db").
 *   Use `Settings.databasePath`, NOT the raw `DATABASE_URL` — better-sqlite3
 *   does not understand the "sqlite:" URL prefix.
 */
export function getDatabase(_databasePath: string): Database.Database {
  // TODO (P032): open/create the SQLite file, run schema migrations
  // for `runs` and `page_diffs` tables.
  throw new Error("Not implemented");
}

export function saveRun(_db: Database.Database, _targetUrl: string, _results: unknown[]): void {
  // TODO (P033): insert a run row and related page_diffs rows.
  throw new Error("Not implemented");
}
