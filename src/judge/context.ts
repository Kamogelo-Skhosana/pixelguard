/**
 * Change-context configuration.
 *
 * Captures what pixelguard needs to know to judge a diff meaningfully:
 * known dynamic regions (timestamps, ads, carousels) and a short
 * description of what changed in this build.
 *
 * Tickets: P018, P019, P020
 */

export interface ChangeContext {
  knownDynamicRegions: { page: string; region: string }[];
  changeDescription: string;
}

export function defaultChangeContext(): ChangeContext {
  // TODO (P019): load known dynamic regions from config.
  return { knownDynamicRegions: [], changeDescription: "" };
}
