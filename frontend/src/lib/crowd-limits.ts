/** Maximum supported headcount for a simulation or an applied camera count. */
export const MAX_CROWD_SIZE = 10_000;
/** POFA's venue capacity; larger scenarios remain available for analysis. */
export const POFA_CAPACITY = 5_000;

export function isSupportedCrowdSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CROWD_SIZE;
}

export function isVenueCapacity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
