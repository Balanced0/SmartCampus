import { z } from 'zod';
import { OptimizeEnergyRequest } from '../types';

const HourDataSchema = z.object({
  hour: z.number().int().min(0).max(23),
  demand_kwh: z.number().nonnegative(),
  solar_kwh: z.number().nonnegative(),
  tariff_bdt_per_kwh: z.number().nonnegative(),
});

const BatterySpecSchema = z.object({
  capacity_kwh: z.number().positive(),
  initial_energy_kwh: z.number().nonnegative(),
  minimum_energy_kwh: z.number().nonnegative(),
  max_charge_kwh_per_hour: z.number().nonnegative(),
  max_discharge_kwh_per_hour: z.number().nonnegative(),
}).refine((data) => data.initial_energy_kwh <= data.capacity_kwh, {
  message: 'initial_energy_kwh must not exceed capacity_kwh',
}).refine((data) => data.minimum_energy_kwh <= data.capacity_kwh, {
  message: 'minimum_energy_kwh must not exceed capacity_kwh',
});

export const OptimizeEnergyRequestSchema = z.object({
  scenario_id: z.string().min(1),
  operator_notes: z.array(z.string()).min(1).max(3),
  hours: z.array(HourDataSchema).length(24).refine((hours) => {
    for (let i = 0; i < 24; i++) {
      if (hours[i].hour !== i) return false;
    }
    return true;
  }, {
    message: 'hours array must contain exactly 24 elements with hour 0 through 23 in order',
  }),
  battery: BatterySpecSchema,
});

export function validateOptimizeRequest(body: unknown): {
  success: boolean;
  data?: OptimizeEnergyRequest;
  error?: string;
} {
  const result = OptimizeEnergyRequestSchema.safeParse(body);
  if (!result.success) {
    const errorDetails = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return {
      success: false,
      error: `Validation error: ${errorDetails}`,
    };
  }
  return {
    success: true,
    data: result.data as OptimizeEnergyRequest,
  };
}
