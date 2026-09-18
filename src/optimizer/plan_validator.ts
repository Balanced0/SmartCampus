import {
  HourlyPlanItem,
  OptimizeEnergyRequest,
  DirectiveInterpretation,
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

    // 1. Energy balance verification: grid + solar + discharge == demand + charge
    const genAndDischarge = plan.grid_kwh + plan.solar_used_kwh + (plan.battery_action === 'discharge' ? plan.battery_kwh : 0);
    const demandAndCharge = hourData.demand_kwh + (plan.battery_action === 'charge' ? plan.battery_kwh : 0);
    if (Math.abs(genAndDischarge - demandAndCharge) > 0.05) {
      violations.push(`Hour ${h}: Energy imbalance. Gen/Discharge=${roundTo(genAndDischarge, 2)} != Demand/Charge=${roundTo(demandAndCharge, 2)}`);
    }

    // 2. Solar bound verification
    if (plan.solar_used_kwh > hourData.solar_kwh + 0.01) {
      violations.push(`Hour ${h}: Solar used (${plan.solar_used_kwh}) exceeds available solar (${hourData.solar_kwh})`);
    }

    // 3. Battery state transition check
    const expectedSoc = prevSoc + (plan.battery_action === 'charge' ? plan.battery_kwh : 0) - (plan.battery_action === 'discharge' ? plan.battery_kwh : 0);
    if (Math.abs(plan.battery_energy_after_kwh - expectedSoc) > 0.05) {
      violations.push(`Hour ${h}: Battery SOC mismatch. Expected ${roundTo(expectedSoc, 2)}, found ${plan.battery_energy_after_kwh}`);
    }

    // 4. Battery bounds check
    if (plan.battery_energy_after_kwh < battery.minimum_energy_kwh - 0.05) {
      violations.push(`Hour ${h}: Battery SOC (${plan.battery_energy_after_kwh}) violates base minimum reserve (${battery.minimum_energy_kwh})`);
    }
    if (plan.battery_energy_after_kwh > battery.capacity_kwh + 0.05) {
      violations.push(`Hour ${h}: Battery SOC (${plan.battery_energy_after_kwh}) exceeds capacity (${battery.capacity_kwh})`);
    }

    prevSoc = plan.battery_energy_after_kwh;
  }

  // End-of-day neutrality check (within 0.05 tolerance)
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
