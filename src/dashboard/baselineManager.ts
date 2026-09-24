/**
 * Baseline management — promoting a "current" capture to the new
 * baseline, and keeping a history of accepted baselines.
 *
 * Tickets: P044, P045
 */

export async function acceptAsBaseline(_currentTag: string): Promise<void> {
  // TODO (P044): copy screenshots/<currentTag>/ over screenshots/baseline/,
  // recording the change in the baseline history.
  throw new Error("Not implemented");
}

export async function getBaselineHistory(): Promise<unknown[]> {
  // TODO (P045): return a list of past baseline promotions with dates.
  throw new Error("Not implemented");
}
