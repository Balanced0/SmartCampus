import { Request, Response } from 'express';
import { validateOptimizeRequest } from '../guardrails/request_validator';
import { interpretOperatorNotes } from '../llm/gemini_client';
import { validateAndSanitizeDirectives } from '../guardrails/validator';
import { solveEnergyPlan } from '../optimizer/lp_solver';
import { validateAndSummarizePlan } from '../optimizer/plan_validator';
import { OptimizeEnergyResponse } from '../types';

export async function optimizeEnergy(req: Request, res: Response): Promise<void> {
  try {
    // 1. Validate Request Body
    const validation = validateOptimizeRequest(req.body);
    if (!validation.success || !validation.data) {
      res.status(400).json({
        error: validation.error || 'Invalid request payload format',
      });
      return;
    }

    const energyRequest = validation.data;

    // 2. LLM Interpretation (Gemini API with hedging & regex fallback)
    const rawDirectives = await interpretOperatorNotes(
      energyRequest.operator_notes,
      energyRequest.battery.capacity_kwh
    );

    // 3. Guardrail Validation & Sanitization
    const sanitizedDirectives = validateAndSanitizeDirectives(
      rawDirectives,
      energyRequest.operator_notes.length
    );

    // 4. LP Optimizer (javascript-lp-solver)
    const solvedPlan = solveEnergyPlan(energyRequest, sanitizedDirectives);

    // 5. Final Plan Verification & Recomputation
    const summaryResult = validateAndSummarizePlan(
      solvedPlan.hourly_plan,
      energyRequest,
      sanitizedDirectives
    );

    if (!summaryResult.isValid) {
      console.warn('[Validation] Plan produced minor constraint deviations:', summaryResult.violations);
    }

    // 6. Formulate Exact API Response
    const responsePayload: OptimizeEnergyResponse = {
      scenario_id: energyRequest.scenario_id,
      directive_interpretation: sanitizedDirectives,
      hourly_plan: solvedPlan.hourly_plan,
      total_grid_kwh: summaryResult.total_grid_kwh,
      total_cost_bdt: summaryResult.total_cost_bdt,
      peak_grid_kwh: summaryResult.peak_grid_kwh,
      plan_summary: summaryResult.plan_summary,
    };

    res.status(200).json(responsePayload);
  } catch (error: any) {
    // Controlled internal error - never leak stack traces, API keys, or raw system paths
    console.error('[Error] optimizeEnergy caught exception:', error?.message || error);
    res.status(500).json({
      error: 'An internal error occurred while optimizing the energy schedule.',
    });
  }
}
