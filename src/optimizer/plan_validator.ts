import {
  HourlyPlanItem,
  OptimizeEnergyRequest,
  DirectiveInterpretation,
  SolarReductionAdjustment,
  MinimumBatteryReserveAdjustment,
  NoChargeWindowAdjustment,
  NoDischargeWindowAdjustment,
  MaxGridWindowAdjustment,
} from '../types';
import { roundTo } from '../utils/tolerance';

export interface ValidationSummaryResult {
  isValid: boolean;
  violations: string[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}

export function validateAndSummarizePlan(
  hourlyPlan: HourlyPlanItem[],
  request: OptimizeEnergyRequest,
  directives: DirectiveInterpretation[]
): ValidationSummaryResult {
  const violations: string[] = [];
  const { hours, battery } = request;

  // ── Pre-compute effective constraints from directives ──────────────
  // The directives modify what the LP was *supposed* to obey.
  // We rebuild those same constraints here so we can verify the plan
  // actually followed them (the LP might have floating-point edge cases).

  // Start with raw solar per hour; directives may reduce it.
  const effectiveSolar = hours.map((h) => h.solar_kwh);
  // Start with the battery's base minimum_energy_kwh; directives may raise it.
  const minBatteryReserve = hours.map(() => battery.minimum_energy_kwh);
  // Track which hours forbid charging / discharging.
  const noChargeHours = new Set<number>();
  const noDischargeHours = new Set<number>();
  // Track per-hour grid caps (null = uncapped).
  const maxGridCap: (number | null)[] = hours.map(() => null);

  for (const dir of directives) {
    if (!dir.applies || !dir.structured_adjustment) continue;

    switch (dir.directive_type) {
      case 'solar_reduction': {
        const adj = dir.structured_adjustment as SolarReductionAdjustment;
        for (const h of adj.hours) {
          if (h >= 0 && h < 24) {
            effectiveSolar[h] = hours[h].solar_kwh * adj.factor;
          }
        }
        break;
      }
      case 'minimum_battery_reserve': {
        const adj = dir.structured_adjustment as MinimumBatteryReserveAdjustment;
        for (const h of adj.hours) {
          if (h >= 0 && h < 24) {
            minBatteryReserve[h] = Math.max(minBatteryReserve[h], adj.minimum_energy_kwh);
          }
        }
        break;
      }
      case 'no_charge_window': {
        const adj = dir.structured_adjustment as NoChargeWindowAdjustment;
        for (const h of adj.hours) noChargeHours.add(h);
        break;
      }
      case 'no_discharge_window': {
        const adj = dir.structured_adjustment as NoDischargeWindowAdjustment;
        for (const h of adj.hours) noDischargeHours.add(h);
        break;
      }
      case 'max_grid_window': {
        const adj = dir.structured_adjustment as MaxGridWindowAdjustment;
        for (const h of adj.hours) {
          if (h >= 0 && h < 24) {
            maxGridCap[h] =
              maxGridCap[h] === null
                ? adj.max_grid_kwh
                : Math.min(maxGridCap[h]!, adj.max_grid_kwh);
          }
        }
        break;
      }
    }
  }

  // ── Walk the 24-hour plan and verify everything ────────────────────

  let totalGridKwh = 0;
  let totalCostBdt = 0;
  let peakGridKwh = 0;
  let totalSolarUsed = 0;
  let totalSolarAvailable = 0;
  let totalCharged = 0;
  let totalDischarged = 0;

  let prevSoc = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const plan = hourlyPlan[h];
    const hourData = hours[h];

    totalSolarAvailable += hourData.solar_kwh;
    totalGridKwh += plan.grid_kwh;
    totalCostBdt += plan.grid_kwh * hourData.tariff_bdt_per_kwh;
    totalSolarUsed += plan.solar_used_kwh;

    if (plan.grid_kwh > peakGridKwh) {
      peakGridKwh = plan.grid_kwh;
    }

    if (plan.battery_action === 'charge') {
      totalCharged += plan.battery_kwh;
    } else if (plan.battery_action === 'discharge') {
      totalDischarged += plan.battery_kwh;
    }

    // ─ Check 1: Energy balance ─
    // grid + solar + discharge == demand + charge
    const genAndDischarge = plan.grid_kwh + plan.solar_used_kwh + (plan.battery_action === 'discharge' ? plan.battery_kwh : 0);
    const demandAndCharge = hourData.demand_kwh + (plan.battery_action === 'charge' ? plan.battery_kwh : 0);
    if (Math.abs(genAndDischarge - demandAndCharge) > 0.05) {
      violations.push(`Hour ${h}: Energy imbalance. Gen/Discharge=${roundTo(genAndDischarge, 2)} != Demand/Charge=${roundTo(demandAndCharge, 2)}`);
    }

    // ─ Check 2: Solar bound (against EFFECTIVE solar, not raw) ─
    // The original code checked against hourData.solar_kwh, which ignores
    // solar_reduction directives. If an 80% reduction was applied, the
    // effective solar is 0.2x the raw value.
    if (plan.solar_used_kwh > effectiveSolar[h] + 0.01) {
      violations.push(`Hour ${h}: Solar used (${plan.solar_used_kwh}) exceeds effective solar (${roundTo(effectiveSolar[h], 4)})`);
    }

    // ─ Check 3: Battery state transition ─
    const expectedSoc = prevSoc + (plan.battery_action === 'charge' ? plan.battery_kwh : 0) - (plan.battery_action === 'discharge' ? plan.battery_kwh : 0);
    if (Math.abs(plan.battery_energy_after_kwh - expectedSoc) > 0.05) {
      violations.push(`Hour ${h}: Battery SOC mismatch. Expected ${roundTo(expectedSoc, 2)}, found ${plan.battery_energy_after_kwh}`);
    }

    // ─ Check 4: Battery bounds (base minimum + capacity) ─
    if (plan.battery_energy_after_kwh < battery.minimum_energy_kwh - 0.05) {
      violations.push(`Hour ${h}: Battery SOC (${plan.battery_energy_after_kwh}) violates base minimum reserve (${battery.minimum_energy_kwh})`);
    }
    if (plan.battery_energy_after_kwh > battery.capacity_kwh + 0.05) {
      violations.push(`Hour ${h}: Battery SOC (${plan.battery_energy_after_kwh}) exceeds capacity (${battery.capacity_kwh})`);
    }

    // ─ Check 5: Directive constraint — minimum_battery_reserve ─
    // An operator note can raise the minimum SOC for specific hours
    // above the battery's base minimum_energy_kwh.
    if (plan.battery_energy_after_kwh < minBatteryReserve[h] - 0.05) {
      violations.push(`Hour ${h}: Battery SOC (${plan.battery_energy_after_kwh}) violates directive minimum reserve (${minBatteryReserve[h]})`);
    }

    // ─ Check 6: Directive constraint — no_charge_window ─
    if (noChargeHours.has(h) && plan.battery_action === 'charge') {
      violations.push(`Hour ${h}: Charging occurred but no_charge_window directive forbids it`);
    }

    // ─ Check 7: Directive constraint — no_discharge_window ─
    if (noDischargeHours.has(h) && plan.battery_action === 'discharge') {
      violations.push(`Hour ${h}: Discharging occurred but no_discharge_window directive forbids it`);
    }

    // ─ Check 8: Directive constraint — max_grid_window ─
    if (maxGridCap[h] !== null && plan.grid_kwh > maxGridCap[h]! + 0.05) {
      violations.push(`Hour ${h}: Grid import (${plan.grid_kwh}) exceeds max_grid_window cap (${maxGridCap[h]})`);
    }

    prevSoc = plan.battery_energy_after_kwh;
  }

  // ─ Check 9: End-of-day neutrality (within 0.05 tolerance) ─
  if (Math.abs(hourlyPlan[23].battery_energy_after_kwh - battery.initial_energy_kwh) > 0.05) {
    violations.push(`End-of-day battery neutrality deviation: final SOC ${hourlyPlan[23].battery_energy_after_kwh} vs initial ${battery.initial_energy_kwh}`);
  }

  // Round metrics
  const roundedTotalGrid = roundTo(totalGridKwh, 4);
  const roundedTotalCost = roundTo(totalCostBdt, 4);
  const roundedPeakGrid = roundTo(peakGridKwh, 4);

  // Active directives count
  const activeDirectives = directives.filter((d) => d.applies && d.directive_type !== 'no_op');

  const planSummary = `Optimization complete for scenario '${request.scenario_id}'. ` +
    `Total cost: ${roundedTotalCost.toFixed(2)} BDT across ${roundedTotalGrid.toFixed(2)} kWh grid import (Peak: ${roundedPeakGrid.toFixed(2)} kWh). ` +
    `Solar utilization: ${roundTo(totalSolarUsed, 2)}/${roundTo(totalSolarAvailable, 2)} kWh. ` +
    `Battery throughput: ${roundTo(totalCharged, 2)} kWh charged, ${roundTo(totalDischarged, 2)} kWh discharged. ` +
    `Applied ${activeDirectives.length} operator directive(s).`;

  return {
    isValid: violations.length === 0,
    violations,
    total_grid_kwh: roundedTotalGrid,
    total_cost_bdt: roundedTotalCost,
    peak_grid_kwh: roundedPeakGrid,
    plan_summary: planSummary,
  };
}

