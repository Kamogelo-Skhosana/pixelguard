/**
 * JSON export of diff results.
 *
 * Ticket: P017
 */

import type { DiffResult } from "../diff/models.js";

export function exportJson(_results: DiffResult[], _path: string): void {
  // TODO (P017): serialize DiffResult[] to JSON and write to disk.
  throw new Error("Not implemented");
}
