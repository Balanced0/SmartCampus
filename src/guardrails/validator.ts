import {
  DirectiveInterpretation,
  DirectiveType,
  SolarReductionAdjustment,
  MinimumBatteryReserveAdjustment,
  NoChargeWindowAdjustment,
  NoDischargeWindowAdjustment,
  MaxGridWindowAdjustment,
  StructuredAdjustment,
} from '../types';
import { sanitizeHours, isValidHoursArray } from '../utils/hour_helpers';
import { clamp } from '../utils/tolerance';

const ALLOWED_DIRECTIVES: Set<DirectiveType> = new Set([
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
]);

/**
 * Deterministically validates and sanitizes LLM directive interpretations.
 * Guarantees that the output matches the required shape for every note index.
 */
export function validateAndSanitizeDirectives(
  rawDirectives: unknown,
  totalNotes: number
): DirectiveInterpretation[] {
  const result: DirectiveInterpretation[] = [];

  const rawArray = Array.isArray(rawDirectives) ? rawDirectives : [];
  const mapByIndex = new Map<number, any>();

  for (const item of rawArray) {
    if (
      item &&
      typeof item === 'object' &&
      typeof item.note_index === 'number' &&
      item.note_index >= 0 &&
      item.note_index < totalNotes &&
      !mapByIndex.has(item.note_index)
    ) {
      mapByIndex.set(item.note_index, item);
    }
  }

  for (let idx = 0; idx < totalNotes; idx++) {
    const raw = mapByIndex.get(idx);
    if (!raw) {
      result.push({
        note_index: idx,
        applies: false,
        directive_type: 'no_op',
        structured_adjustment: null,
        explanation: 'Defaulted to no_op (missing in LLM output)',
      });
      continue;
    }

    const validated = validateSingleDirective(raw, idx);
    result.push(validated);
  }

  return result;
}

function validateSingleDirective(raw: any, expectedIndex: number): DirectiveInterpretation {
  const directiveType: DirectiveType = ALLOWED_DIRECTIVES.has(raw.directive_type)
    ? raw.directive_type
    : 'no_op';

  const explanation =
    typeof raw.explanation === 'string' && raw.explanation.trim() !== ''
      ? raw.explanation.trim()
      : `Interpreted note ${expectedIndex}`;

  if (directiveType === 'no_op') {
    return {
      note_index: expectedIndex,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation,
    };
  }

  const adj = raw.structured_adjustment;
  if (!adj || typeof adj !== 'object') {
    return {
      note_index: expectedIndex,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation: `${explanation} (Sanitized to no_op: missing structured_adjustment)`,
    };
  }

  // Validate hours
  const hours = isValidHoursArray(adj.hours) ? adj.hours : sanitizeHours(adj.hours);
  if (hours.length === 0) {
    return {
      note_index: expectedIndex,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation: `${explanation} (Sanitized to no_op: invalid or empty hours window)`,
    };
  }

  switch (directiveType) {
    case 'solar_reduction': {
      let factor = typeof adj.factor === 'number' ? adj.factor : parseFloat(String(adj.factor));
      if (!Number.isFinite(factor) || isNaN(factor)) {
        return {
          note_index: expectedIndex,
          applies: false,
          directive_type: 'no_op',
          structured_adjustment: null,
          explanation: `${explanation} (Sanitized to no_op: invalid solar reduction factor)`,
        };
      }
      factor = clamp(factor, 0, 1);
      const adjustment: SolarReductionAdjustment = { hours, factor };
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: 'solar_reduction',
        structured_adjustment: adjustment,
        explanation,
      };
    }

    case 'minimum_battery_reserve': {
      let minKwh =
        typeof adj.minimum_energy_kwh === 'number'
          ? adj.minimum_energy_kwh
          : parseFloat(String(adj.minimum_energy_kwh));
      if (!Number.isFinite(minKwh) || minKwh < 0 || isNaN(minKwh)) {
        return {
          note_index: expectedIndex,
          applies: false,
          directive_type: 'no_op',
          structured_adjustment: null,
          explanation: `${explanation} (Sanitized to no_op: invalid minimum_energy_kwh)`,
        };
      }
      const adjustment: MinimumBatteryReserveAdjustment = {
        hours,
        minimum_energy_kwh: minKwh,
      };
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: 'minimum_battery_reserve',
        structured_adjustment: adjustment,
        explanation,
      };
    }

    case 'no_charge_window': {
      const adjustment: NoChargeWindowAdjustment = { hours };
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: 'no_charge_window',
        structured_adjustment: adjustment,
        explanation,
      };
    }

    case 'no_discharge_window': {
      const adjustment: NoDischargeWindowAdjustment = { hours };
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: 'no_discharge_window',
        structured_adjustment: adjustment,
        explanation,
      };
    }

    case 'max_grid_window': {
      let maxGrid =
        typeof adj.max_grid_kwh === 'number'
          ? adj.max_grid_kwh
          : parseFloat(String(adj.max_grid_kwh));
      if (!Number.isFinite(maxGrid) || maxGrid < 0 || isNaN(maxGrid)) {
        return {
          note_index: expectedIndex,
          applies: false,
          directive_type: 'no_op',
          structured_adjustment: null,
          explanation: `${explanation} (Sanitized to no_op: invalid max_grid_kwh)`,
        };
      }
      const adjustment: MaxGridWindowAdjustment = {
        hours,
        max_grid_kwh: maxGrid,
      };
      return {
        note_index: expectedIndex,
        applies: true,
        directive_type: 'max_grid_window',
        structured_adjustment: adjustment,
        explanation,
      };
    }

    default: {
      return {
        note_index: expectedIndex,
        applies: false,
        directive_type: 'no_op',
        structured_adjustment: null,
        explanation,
      };
    }
  }
}
