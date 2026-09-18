/**
 * Utility functions for numeric tolerance and precision handling.
 */

export function roundTo(val: number, decimals: number = 4): number {
  if (!Number.isFinite(val)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

export function approxEqual(a: number, b: number, epsilon: number = 1e-3): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}
