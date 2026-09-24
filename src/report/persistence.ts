/**
 * SQLite persistence for runs and page diffs.
 *
 * Tickets: P032, P033
 */

import Database from "better-sqlite3";

export function getDatabase(databaseUrl: string): Database.Database {
  // TODO (P032): open/create the SQLite file, run schema migrations
  // for `runs` and `page_diffs` tables.
  throw new Error("Not implemented");
}

export function saveRun(db: Database.Database, targetUrl: string, results: unknown[]): void {
  // TODO (P033): insert a run row and related page_diffs rows.
  throw new Error("Not implemented");
}
