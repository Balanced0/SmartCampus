/**
 * Helpers for 24-hour windows (0-23)
 */

export function sanitizeHours(hours: unknown): number[] {
  if (!Array.isArray(hours)) return [];
  const valid = hours
    .map((h) => (typeof h === 'number' ? Math.floor(h) : parseInt(String(h), 10)))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  
  // Return unique, strictly ascending sorted array
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

export function isValidHoursArray(hours: unknown): hours is number[] {
  if (!Array.isArray(hours) || hours.length === 0) return false;
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    if (!Number.isInteger(h) || h < 0 || h > 23) return false;
    if (i > 0 && h <= hours[i - 1]) return false; // must be strictly ascending
  }
  return true;
}
