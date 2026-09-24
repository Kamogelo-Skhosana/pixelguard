/**
 * JSON export of diff results.
 *
 * Ticket: P017
 */

import type { DiffResult } from "../diff/models.js";

export function exportJson(results: DiffResult[], path: string): void {
  // TODO (P017): serialize DiffResult[] to JSON and write to disk.
  throw new Error("Not implemented");
}
