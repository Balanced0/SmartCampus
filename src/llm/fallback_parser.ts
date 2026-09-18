/**
 * Regex-based last-resort fallback interpreter for operator notes.
 * Only runs when ALL LLM model attempts have failed.
 * LLM is the primary interpreter; this handles complete LLM unavailability.
 * Output is structurally identical to LLM output and goes through the same guardrail.
 */
import { DirectiveInterpretation } from '../types';

// ── Time window helpers ───────────────────────────────────────────────────────

const HOUR12_RE =
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
const HOUR24_RE =
  /(\d{1,2}):(\d{2})/g;

function to24(h: number, min: number, ampm: string): number {
  let hour = h % 12;
  if (ampm.toLowerCase() === 'pm') hour += 12;
  return hour;
}

/**
 * Parse a time string like "1 PM", "13:00", "1:30 PM" into an hour integer 0-23.
 * Returns null if unparseable.
 */
function parseHour(token: string): number | null {
  // 12h format: "1 PM", "1:30 PM", "2AM"
  const m12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(token.trim());
  if (m12) {
    return to24(parseInt(m12[1]), parseInt(m12[2] || '0'), m12[3]);
  }
  // 24h format: "13:00"
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(token.trim());
  if (m24) {
    const h = parseInt(m24[1]);
    return h >= 0 && h <= 23 ? h : null;
  }
  return null;
}

/**
 * Extract a time range from text. Returns [startHour, endHour] (end-exclusive).
 * Handles:
 *   - "1 PM to 3 PM" / "13:00 to 15:00"
 *   - "from 2 AM until 5 AM" / "from 2 AM to 5 AM"
 *   - "between X and Y"
 *   - overnight wrap: "10 PM to 6 AM" → [0..5, 22, 23]
 * Returns null if no valid range found.
 */
function extractHours(text: string): number[] | null {
  // Normalize separators
  const t = text.replace(/\buntil\b/gi, 'to').replace(/\band\b/gi, 'to');

  // Try to find two time tokens around a "to" / "-"
  const rangeRe = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
  const match = rangeRe.exec(t);
  if (!match) return null;

  const start = parseHour(match[1]);
  const end = parseHour(match[2]);
  if (start === null || end === null) return null;

  if (start < end) {
    const hrs: number[] = [];
    for (let h = start; h < end; h++) hrs.push(h);
    return hrs;
  } else {
    // Overnight wrap: e.g., 22 to 6 → [22, 23, 0, 1, 2, 3, 4, 5]
    const hrs: number[] = [];
    for (let h = start; h < 24; h++) hrs.push(h);
    for (let h = 0; h < end; h++) hrs.push(h);
    return hrs.sort((a, b) => a - b);
  }
}

// ── Regex patterns ────────────────────────────────────────────────────────────

const SOLAR_RE =
  /(?:solar|panel|pv|generation|photovoltaic).{0,80}?(?:(\d+(?:\.\d+)?)\s*%\s*(?:reduction|drop|curtail|cut|less|down|lower|reduced|decrease)|drop\s*to\s*(\d+(?:\.\d+)?)\s*%|(?:only|about|roughly|approximately|treated?\s+as)\s*(\d+(?:\.\d+)?)\s*%(?:\s+(?:of|available|remain|usable|forecast))?|(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+)?forecast)/i;

const NO_CHARGE_RE =
  /(?:no\s+charg|charg(?:er|ing)?\s+(?:disabled?|off|isolated?|prohibited?|suspended?|block|stopp|prohibit|will\s+be|cannot|unavailable|maintenance|not\s+available|cannot\s+be)|battery\s+charg\w*\s+(?:not|no|disabled?|off|prohibit|unavailable|cannot)|will\s+(?:not|be\s+unable)\s+to\s+charg|charg(?:er|ing)?\s+will\s+(?:not|be\s+isolat|be\s+suspend|be\s+off|be\s+disabled))/i;

const NO_DISCHARGE_RE =
  /(?:no\s+discharg|discharg\w*\s+(?:disabled?|off|prohibited?|suspended?|block|stopp|prohibit|must\s+not|cannot|will\s+not)|battery\s+(?:must\s+not|cannot|should\s+not|will\s+not)\s+discharg|discharg\w*\s+will\s+(?:not|be\s+disabled|be\s+prohibited|be\s+blocked)|must\s+not\s+discharg|not\s+discharg|for\s+protection\s+testing.{0,50}discharg)/i;

const MIN_RESERVE_RE =
  /(?:minimum|min|keep|maintain|hold|reserve|emergency|safety|backup|must\s+have|store|stored)\s+(?:at\s+least\s+)?(?:battery\s+)?(?:reserve|capacity|charge|energy|soc|state\s+of\s+charge)?.{0,60}?(\d+(?:\.\d+)?)\s*kwh/i;

const MAX_GRID_RE =
  /(?:grid|import|draw|power\s+draw|utility|feeder|substation|transformer|supply|mains).{0,60}?(?:cap|capped?|limit(?:ed)?|maximum|max|cannot\s+exceed|must\s+not\s+exceed|restricted?\s+to|no\s+more\s+than)\s*(?:at\s+|to\s+)?(\d+(?:\.\d+)?)\s*kwh/i;

// ── Per-note parser ───────────────────────────────────────────────────────────

function parseNote(
  note: string,
  idx: number,
  batteryCapacityKwh?: number
): DirectiveInterpretation {
  const noOp = (): DirectiveInterpretation => ({
    note_index: idx,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: `[regex-fallback] Note did not match any known energy directive pattern.`,
  });

  // ── solar_reduction ─────────────────────────────────────────────────────────
  const solarMatch = SOLAR_RE.exec(note);
  if (solarMatch) {
    const hours = extractHours(note);
    if (!hours || hours.length === 0) return noOp();

    let factor: number;
    if (solarMatch[1]) {
      // "X% reduction/drop" → factor = 1 - X/100
      factor = 1 - parseFloat(solarMatch[1]) / 100;
    } else if (solarMatch[2]) {
      // "drop to X%" → factor = X/100
      factor = parseFloat(solarMatch[2]) / 100;
    } else if (solarMatch[3]) {
      // "only/about/treated as X% [of forecast/available]" → factor = X/100
      factor = parseFloat(solarMatch[3]) / 100;
    } else {
      // "X% of forecast" → factor = X/100
      factor = parseFloat(solarMatch[4]) / 100;
    }
    factor = Math.min(1, Math.max(0, factor));

    return {
      note_index: idx,
      applies: true,
      directive_type: 'solar_reduction',
      structured_adjustment: { hours, factor },
      explanation: `[regex-fallback] Solar availability reduced to factor ${factor.toFixed(2)} during hours ${JSON.stringify(hours)}.`,
    };
  }

  // ── no_charge_window ────────────────────────────────────────────────────────
  if (NO_CHARGE_RE.test(note)) {
    const hours = extractHours(note);
    if (!hours || hours.length === 0) return noOp();
    return {
      note_index: idx,
      applies: true,
      directive_type: 'no_charge_window',
      structured_adjustment: { hours },
      explanation: `[regex-fallback] Battery charging prohibited during hours ${JSON.stringify(hours)}.`,
    };
  }

  // ── no_discharge_window ─────────────────────────────────────────────────────
  if (NO_DISCHARGE_RE.test(note)) {
    const hours = extractHours(note);
    if (!hours || hours.length === 0) return noOp();
    return {
      note_index: idx,
      applies: true,
      directive_type: 'no_discharge_window',
      structured_adjustment: { hours },
      explanation: `[regex-fallback] Battery discharging prohibited during hours ${JSON.stringify(hours)}.`,
    };
  }

  // ── minimum_battery_reserve (kWh stated) ────────────────────────────────────
  const reserveMatch = MIN_RESERVE_RE.exec(note);
  if (reserveMatch) {
    let minimum_energy_kwh = parseFloat(reserveMatch[1]);
    const hours = extractHours(note);
    if (!hours || hours.length === 0) return noOp();

    // Clamp to capacity if we know it
    if (batteryCapacityKwh !== undefined) {
      minimum_energy_kwh = Math.min(minimum_energy_kwh, batteryCapacityKwh);
    }

    return {
      note_index: idx,
      applies: true,
      directive_type: 'minimum_battery_reserve',
      structured_adjustment: { hours, minimum_energy_kwh },
      explanation: `[regex-fallback] Minimum battery reserve of ${minimum_energy_kwh} kWh during hours ${JSON.stringify(hours)}.`,
    };
  }

  // ── max_grid_window ─────────────────────────────────────────────────────────
  const gridMatch = MAX_GRID_RE.exec(note);
  if (gridMatch) {
    const max_grid_kwh = parseFloat(gridMatch[1]);
    const hours = extractHours(note);
    if (!hours || hours.length === 0) return noOp();
    return {
      note_index: idx,
      applies: true,
      directive_type: 'max_grid_window',
      structured_adjustment: { hours, max_grid_kwh },
      explanation: `[regex-fallback] Grid import capped at ${max_grid_kwh} kWh during hours ${JSON.stringify(hours)}.`,
    };
  }

  return noOp();
}

/**
 * Parse all operator notes using regex patterns.
 * Called only when the LLM is completely unavailable.
 */
export function parseNotesWithRegex(
  notes: string[],
  batteryCapacityKwh?: number
): DirectiveInterpretation[] {
  return notes.map((note, idx) => parseNote(note, idx, batteryCapacityKwh));
}
