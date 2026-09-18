/**
 * scripts/test_sample_cases.ts
 * Runs all 10 public sample cases against the GridWise API.
 * Usage:
 *   BASE_URL=http://localhost:3000 npx tsx scripts/test_sample_cases.ts
 *   BASE_URL=https://smart-campus-seven-hazel.vercel.app npx tsx scripts/test_sample_cases.ts
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOLERANCE = 0.01; // kWh / BDT tolerance per spec

// ── Load sample cases ──────────────────────────────────────────────────────────
const casesPath = path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json');
const casesData = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const cases: any[] = casesData.cases;

// ── HTTP helper ────────────────────────────────────────────────────────────────
function postJson(url: string, body: any): Promise<{ status: number; data: any; ms: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          const ms = Date.now() - start;
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw), ms });
          } catch {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('Request timed out after 35s')); });
    req.write(payload);
    req.end();
  });
}

// ── Constraint checkers ────────────────────────────────────────────────────────
function near(a: number, b: number, tol = TOLERANCE): boolean {
  return Math.abs(a - b) <= tol;
}

interface CheckResult { ok: boolean; failures: string[] }

function checkPlan(resp: any, caseInput: any, expected: any): CheckResult {
  const failures: string[] = [];
  const plan: any[] = resp.hourly_plan;
  const battery = caseInput.battery;
  const hours: any[] = caseInput.hours;

  // 1. Must have exactly 24 entries
  if (!plan || plan.length !== 24) {
    failures.push(`hourly_plan has ${plan?.length} entries (expected 24)`);
    return { ok: false, failures };
  }

  // Build effective solar map (apply solar_reduction directives from response)
  const effectiveSolar: number[] = hours.map((h: any) => h.solar_kwh);
  const directives: any[] = resp.directive_interpretation || [];
  for (const dir of directives) {
    if (dir.applies && dir.directive_type === 'solar_reduction' && dir.structured_adjustment?.hours) {
      for (const h of dir.structured_adjustment.hours) {
        if (h >= 0 && h < 24) {
          effectiveSolar[h] = hours[h].solar_kwh * dir.structured_adjustment.factor;
        }
      }
    }
  }

  // Build per-hour directive constraints
  const noChargeHours = new Set<number>();
  const noDischargeHours = new Set<number>();
  const minReserve: number[] = hours.map(() => battery.minimum_energy_kwh);
  const maxGrid: (number | null)[] = hours.map(() => null);

  for (const dir of directives) {
    if (!dir.applies || !dir.structured_adjustment) continue;
    const adj = dir.structured_adjustment;
    if (dir.directive_type === 'no_charge_window' && adj.hours) {
      adj.hours.forEach((h: number) => noChargeHours.add(h));
    }
    if (dir.directive_type === 'no_discharge_window' && adj.hours) {
      adj.hours.forEach((h: number) => noDischargeHours.add(h));
    }
    if (dir.directive_type === 'minimum_battery_reserve' && adj.hours) {
      for (const h of adj.hours) {
        if (h >= 0 && h < 24) {
          minReserve[h] = Math.max(minReserve[h], adj.minimum_energy_kwh);
        }
      }
    }
    if (dir.directive_type === 'max_grid_window' && adj.hours) {
      for (const h of adj.hours) {
        if (h >= 0 && h < 24) {
          maxGrid[h] = maxGrid[h] === null ? adj.max_grid_kwh : Math.min(maxGrid[h]!, adj.max_grid_kwh);
        }
      }
    }
  }

  let soc = battery.initial_energy_kwh;

  for (let i = 0; i < 24; i++) {
    const row = plan[i];
    const demand = hours[i].demand_kwh;
    const tariff = hours[i].tariff_bdt_per_kwh;
    const h = row.hour;

    // hour field must match index
    if (h !== i) failures.push(`h${i}: hour field is ${h}, expected ${i}`);

    const grid = row.grid_kwh ?? 0;
    const solar = row.solar_used_kwh ?? 0;
    const action = row.battery_action;
    const bkwh = row.battery_kwh ?? 0;
    const socAfter = row.battery_energy_after_kwh ?? 0;

    // 2. Energy balance: grid + solar + discharge - charge == demand
    const discharge = action === 'discharge' ? bkwh : 0;
    const charge = action === 'charge' ? bkwh : 0;
    const balance = grid + solar + discharge - charge;
    if (!near(balance, demand)) {
      failures.push(`h${h}: energy balance ${balance.toFixed(4)} ≠ demand ${demand} (Δ${Math.abs(balance-demand).toFixed(4)})`);
    }

    // 3. Solar used <= effective solar
    if (solar > effectiveSolar[h] + TOLERANCE) {
      failures.push(`h${h}: solar_used ${solar} > effective_solar ${effectiveSolar[h].toFixed(4)}`);
    }

    // 4. No charge in no-charge window
    if (noChargeHours.has(h) && charge > TOLERANCE) {
      failures.push(`h${h}: charge ${charge} in no_charge_window`);
    }

    // 5. No discharge in no-discharge window
    if (noDischargeHours.has(h) && discharge > TOLERANCE) {
      failures.push(`h${h}: discharge ${discharge} in no_discharge_window`);
    }

    // 6. Battery rate limits
    if (charge > battery.max_charge_kwh_per_hour + TOLERANCE) {
      failures.push(`h${h}: charge ${charge} > max_charge ${battery.max_charge_kwh_per_hour}`);
    }
    if (discharge > battery.max_discharge_kwh_per_hour + TOLERANCE) {
      failures.push(`h${h}: discharge ${discharge} > max_discharge ${battery.max_discharge_kwh_per_hour}`);
    }

    // 7. SOC transition
    const expectedSoc = soc + charge - discharge;
    if (!near(socAfter, expectedSoc, 0.05)) {
      failures.push(`h${h}: SOC ${socAfter.toFixed(4)} ≠ expected ${expectedSoc.toFixed(4)}`);
    }
    soc = socAfter;

    // 8. SOC bounds
    if (socAfter < minReserve[h] - TOLERANCE) {
      failures.push(`h${h}: SOC ${socAfter.toFixed(4)} < min_reserve ${minReserve[h]}`);
    }
    if (socAfter > battery.capacity_kwh + TOLERANCE) {
      failures.push(`h${h}: SOC ${socAfter.toFixed(4)} > capacity ${battery.capacity_kwh}`);
    }

    // 9. Grid cap
    if (maxGrid[h] !== null && grid > maxGrid[h]! + TOLERANCE) {
      failures.push(`h${h}: grid ${grid} > max_grid_cap ${maxGrid[h]}`);
    }
  }

  // 10. End-of-day neutrality: final SOC == initial
  if (!near(soc, battery.initial_energy_kwh, 0.05)) {
    failures.push(`End-of-day SOC ${soc.toFixed(4)} ≠ initial ${battery.initial_energy_kwh}`);
  }

  // 11. Totals recomputed from hourly_plan
  let computedGrid = 0, computedCost = 0, computedPeak = 0;
  for (let i = 0; i < 24; i++) {
    const g = plan[i].grid_kwh ?? 0;
    computedGrid += g;
    computedCost += g * hours[i].tariff_bdt_per_kwh;
    computedPeak = Math.max(computedPeak, g);
  }
  if (!near(resp.total_grid_kwh, computedGrid)) {
    failures.push(`total_grid_kwh ${resp.total_grid_kwh} ≠ recomputed ${computedGrid.toFixed(4)}`);
  }
  if (!near(resp.total_cost_bdt, computedCost, 0.1)) {
    failures.push(`total_cost_bdt ${resp.total_cost_bdt} ≠ recomputed ${computedCost.toFixed(4)}`);
  }
  if (!near(resp.peak_grid_kwh, computedPeak)) {
    failures.push(`peak_grid_kwh ${resp.peak_grid_kwh} ≠ recomputed ${computedPeak.toFixed(4)}`);
  }

  // 12. Compare directive_interpretation against expected (type and hours only)
  if (expected?.directive_interpretation) {
    for (const exp of expected.directive_interpretation) {
      const got = (resp.directive_interpretation || []).find((d: any) => d.note_index === exp.note_index);
      if (!got) {
        failures.push(`directive[${exp.note_index}]: missing from response`);
        continue;
      }
      if (got.directive_type !== exp.directive_type) {
        failures.push(`directive[${exp.note_index}]: type ${got.directive_type} ≠ expected ${exp.directive_type}`);
      }
      if (got.applies !== exp.applies) {
        failures.push(`directive[${exp.note_index}]: applies ${got.applies} ≠ expected ${exp.applies}`);
      }
      // Check structured_adjustment if expected has one
      if (exp.structured_adjustment && got.structured_adjustment) {
        if (exp.structured_adjustment.hours) {
          const expH = JSON.stringify(exp.structured_adjustment.hours);
          const gotH = JSON.stringify(got.structured_adjustment.hours);
          if (expH !== gotH) {
            failures.push(`directive[${exp.note_index}]: hours ${gotH} ≠ expected ${expH}`);
          }
        }
        if (exp.structured_adjustment.factor !== undefined) {
          if (!near(got.structured_adjustment.factor, exp.structured_adjustment.factor, 0.02)) {
            failures.push(`directive[${exp.note_index}]: factor ${got.structured_adjustment.factor} ≠ expected ${exp.structured_adjustment.factor}`);
          }
        }
        if (exp.structured_adjustment.minimum_energy_kwh !== undefined) {
          if (!near(got.structured_adjustment.minimum_energy_kwh, exp.structured_adjustment.minimum_energy_kwh, 0.5)) {
            failures.push(`directive[${exp.note_index}]: min_reserve ${got.structured_adjustment.minimum_energy_kwh} ≠ expected ${exp.structured_adjustment.minimum_energy_kwh}`);
          }
        }
      }
    }
  }

  // 13. Cost vs reference (if expected_output has it)
  if (expected?.total_cost_bdt !== undefined) {
    if (!near(resp.total_cost_bdt, expected.total_cost_bdt, expected.total_cost_bdt * 0.001 + 0.5)) {
      // Not a hard failure — just note it, since equivalent schedules may differ
      failures.push(`WARN: total_cost_bdt ${resp.total_cost_bdt.toFixed(2)} vs reference ${expected.total_cost_bdt} (may be an equivalent optimal schedule)`);
    }
  }

  return { ok: failures.filter(f => !f.startsWith('WARN:')).length === 0, failures };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔬 GridWise Sample Case Test Runner`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Cases:  ${cases.length}`);
  console.log(`   Tol:    ±${TOLERANCE} kWh/BDT\n`);
  console.log('─'.repeat(80));

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const { id, label, input, expected_output } = tc;
    process.stdout.write(`[${id}] ${label} ... `);

    try {
      const { status, data, ms } = await postJson(`${BASE_URL}/optimize-energy`, input);
      if (status !== 200) {
        console.log(`❌ FAIL  HTTP ${status}`);
        console.log(`   Error: ${JSON.stringify(data).slice(0, 200)}`);
        failed++;
        continue;
      }

      const { ok, failures } = checkPlan(data, input, expected_output);
      const cost = data.total_cost_bdt?.toFixed(2) ?? 'N/A';
      const grid = data.total_grid_kwh?.toFixed(2) ?? 'N/A';
      const dirType = (data.directive_interpretation || []).map((d: any) => d.directive_type).join(', ');

      if (ok) {
        console.log(`✅ PASS  ${ms}ms  cost=${cost} BDT  grid=${grid} kWh  directives=[${dirType}]`);
        passed++;
      } else {
        console.log(`❌ FAIL  ${ms}ms  cost=${cost} BDT`);
        for (const f of failures) {
          console.log(`   • ${f}`);
        }
        failed++;
      }
    } catch (err: any) {
      console.log(`❌ ERROR  ${err?.message}`);
      failed++;
    }
  }

  console.log('─'.repeat(80));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${cases.length} cases`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
