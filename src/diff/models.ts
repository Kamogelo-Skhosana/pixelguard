/**
 * Internal DiffResult data model — the normalized shape every pixel
 * diff gets represented as before it reaches the judge layer.
 *
 * Ticket: P013
 */

export interface DiffResult {
  page: string;
  viewport: string;
  pixelDiffCount: number;
  percentChanged: number;
  diffImagePath: string;

  // Populated later by the judge layer (Phase 2) — see P024
  verdict?: "Real Bug" | "Acceptable Change" | "Uncertain";
  confidence?: number;
  explanation?: string;
}
