export const DEFAULT_INTERVAL_MS = 2000
export const MIN_INTERVAL_MS = 1000
export const MAX_INTERVAL_MS = 60000

/** Accept only finite integer timer values within the package's bounded range. */
export function normalizeIntervalMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= MIN_INTERVAL_MS && value <= MAX_INTERVAL_MS
    ? value
    : DEFAULT_INTERVAL_MS
}
