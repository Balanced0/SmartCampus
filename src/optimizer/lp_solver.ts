import solver, { LPModel } from 'javascript-lp-solver';
import {
  OptimizeEnergyRequest,
  DirectiveInterpretation,
  HourlyPlanItem,
  SolarReductionAdjustment,
  MinimumBatteryReserveAdjustment,
  NoChargeWindowAdjustment,
  NoDischargeWindowAdjustment,
  MaxGridWindowAdjustment,
} from '../types';
import { roundTo } from '../utils/tolerance';

export interface SolvedPlan {
  hourly_plan: HourlyPlanItem[];
  feasible: boolean;
  solver_result: number;
}

export function solveEnergyPlan(
  request: OptimizeEnergyRequest,
  directives: DirectiveInterpretation[]
): SolvedPlan {
  const { hours, battery } = request;

  // Prepare hourly constraint adjustments based on directives
  const effectiveSolar = hours.map((h) => h.solar_kwh);
  const minBatteryReserve = hours.map(() => battery.minimum_energy_kwh);
  const maxChargeRate = hours.map(() => battery.max_charge_kwh_per_hour);
  const maxDischargeRate = hours.map(() => battery.max_discharge_kwh_per_hour);
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
        for (const h of adj.hours) {
          if (h >= 0 && h < 24) {
            maxChargeRate[h] = 0;
          }
        }
        break;
      }

      case 'no_discharge_window': {
        const adj = dir.structured_adjustment as NoDischargeWindowAdjustment;
        for (const h of adj.hours) {
          if (h >= 0 && h < 24) {
            maxDischargeRate[h] = 0;
          }
        }
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

      case 'no_op':
      default:
        break;
    }
  }

  // Build LP Model
  const model: LPModel = {
    optimize: 'cost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  // Add constraints and variables for 24 hours
  for (let h = 0; h < 24; h++) {
    const hourData = hours[h];

    // 1. Energy Balance: grid_h + solar_h + discharge_h - charge_h == demand_h
    model.constraints[`balance_${h}`] = { equal: hourData.demand_kwh };

    // 2. Solar bound: solar_h <= effectiveSolar[h]
    model.constraints[`solar_limit_${h}`] = { max: effectiveSolar[h] };

    // 3. Charge bound: charge_h <= maxChargeRate[h]
    model.constraints[`charge_limit_${h}`] = { max: maxChargeRate[h] };

    // 4. Discharge bound: discharge_h <= maxDischargeRate[h]
    model.constraints[`discharge_limit_${h}`] = { max: maxDischargeRate[h] };

    // 5. Battery SOC limits
    model.constraints[`soc_min_${h}`] = { min: minBatteryReserve[h] };
    model.constraints[`soc_max_${h}`] = { max: battery.capacity_kwh };

    // 6. SOC transition:
    // For h = 0: soc_0 - charge_0 + discharge_0 = initial_energy_kwh
    // For h > 0: soc_h - soc_{h-1} - charge_h + discharge_h = 0
    if (h === 0) {
      model.constraints[`soc_trans_${h}`] = { equal: battery.initial_energy_kwh };
    } else {
      model.constraints[`soc_trans_${h}`] = { equal: 0 };
    }

    // 7. Grid cap constraint if active
    if (maxGridCap[h] !== null) {
      model.constraints[`grid_cap_${h}`] = { max: maxGridCap[h]! };
    }

    // Define Variables for hour h
    // Variable: grid_h
    const gridVar: Record<string, number> = {
      cost: hourData.tariff_bdt_per_kwh,
      [`balance_${h}`]: 1,
    };
    if (maxGridCap[h] !== null) {
      gridVar[`grid_cap_${h}`] = 1;
    }
    model.variables[`grid_${h}`] = gridVar;

    // Variable: solar_used_h
    model.variables[`solar_${h}`] = {
      cost: 0,
      [`balance_${h}`]: 1,
      [`solar_limit_${h}`]: 1,
    };

    // Variable: charge_h (tiny epsilon cost to discourage unnecessary cycling/simultaneous discharge)
    model.variables[`charge_${h}`] = {
      cost: 1e-6,
      [`balance_${h}`]: -1,
      [`charge_limit_${h}`]: 1,
      [`soc_trans_${h}`]: -1,
    };

    // Variable: discharge_h (tiny epsilon cost)
    model.variables[`discharge_${h}`] = {
      cost: 1e-6,
      [`balance_${h}`]: 1,
      [`discharge_limit_${h}`]: 1,
      [`soc_trans_${h}`]: 1,
    };

    // Variable: soc_h
    const socVar: Record<string, number> = {
      cost: 0,
      [`soc_min_${h}`]: 1,
      [`soc_max_${h}`]: 1,
      [`soc_trans_${h}`]: 1,
    };
    if (h < 23) {
      // Connects to next hour's transition: -soc_{h}
      socVar[`soc_trans_${h + 1}`] = -1;
    }
    model.variables[`soc_${h}`] = socVar;
  }

  // 8. End-of-day neutrality constraint: soc_23 == initial_energy_kwh
  model.constraints['soc_end_neutrality'] = { equal: battery.initial_energy_kwh };
  model.variables['soc_23']['soc_end_neutrality'] = 1;

  // Solve the LP model
  const solution = solver.Solve(model);

  if (!solution || solution.feasible === false) {
    // If strict neutrality makes it slightly infeasible or constrained, relax end-of-day slightly
    console.warn('[Optimizer] Primary solve infeasible, attempting solve with relaxed tolerance.');
    model.constraints['soc_end_neutrality'] = {
      min: Math.max(battery.minimum_energy_kwh, battery.initial_energy_kwh - 0.01),
      max: Math.min(battery.capacity_kwh, battery.initial_energy_kwh + 0.01),
    };
    const relaxedSolution = solver.Solve(model);

    if (relaxedSolution && relaxedSolution.feasible !== false) {
      return formatSolution(relaxedSolution, hours, battery.initial_energy_kwh);
    }

    throw new Error('Linear programming optimizer found no feasible energy schedule satisfying all constraints.');
  }

  return formatSolution(solution, hours, battery.initial_energy_kwh);
}

function formatSolution(
  solution: any,
  hours: OptimizeEnergyRequest['hours'],
  initialEnergy: number
): SolvedPlan {
  const hourlyPlan: HourlyPlanItem[] = [];

  // We recompute SOC step-by-step from the rounded charge/discharge values
  // rather than trusting the LP's raw floating-point soc variable.
  // Why: The LP returns values like charge=5.00001 which we round to 5.0,
  // but the LP's internal SOC was computed from the unrounded value.
  // If we used the LP's SOC directly, battery_energy_after_kwh would drift
  // from what the battery_kwh and battery_action fields actually say happened.
  let computedSoc = initialEnergy;

  for (let h = 0; h < 24; h++) {
    const rawGrid = solution[`grid_${h}`] || 0;
    const rawSolar = solution[`solar_${h}`] || 0;
    const rawCharge = solution[`charge_${h}`] || 0;
    const rawDischarge = solution[`discharge_${h}`] || 0;

    const gridKwh = Math.max(0, roundTo(rawGrid, 4));
    const solarUsedKwh = Math.max(0, roundTo(rawSolar, 4));

    // Net simultaneous charge/discharge into one direction (LP epsilon artifact fix).
    // Zero the smaller value so only one direction is non-zero.
    let netCharge = Math.max(0, rawCharge - rawDischarge);
    let netDischarge = Math.max(0, rawDischarge - rawCharge);
    netCharge = Math.max(0, roundTo(netCharge, 4));
    netDischarge = Math.max(0, roundTo(netDischarge, 4));

    let action: 'charge' | 'discharge' | 'idle' = 'idle';
    let batteryKwh = 0;

    if (netCharge > 1e-6) {
      action = 'charge';
      batteryKwh = roundTo(netCharge, 6); // 6 decimal precision as required
    } else if (netDischarge > 1e-6) {
      action = 'discharge';
      batteryKwh = roundTo(netDischarge, 6);
    }

    // Recompute SOC from net values so the output is always self-consistent.
    if (action === 'charge') {
      computedSoc = roundTo(computedSoc + batteryKwh, 6);
    } else if (action === 'discharge') {
      computedSoc = roundTo(computedSoc - batteryKwh, 6);
    }

    hourlyPlan.push({
      hour: h,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsedKwh,
      battery_action: action,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: roundTo(computedSoc, 6),
    });
  }

  return {
    hourly_plan: hourlyPlan,
    feasible: true,
    solver_result: solution.result || 0,
  };
}
