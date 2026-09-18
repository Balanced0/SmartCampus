# GridWise LLM — Energy Optimization API

**BUP CSE Fest 2026 · Hackathon Preliminary**

A **stateless HTTP API** that interprets natural-language operator notes with Google Gemini LLM, validates them through deterministic guardrails, and runs a 24-hour battery/grid cost optimizer using Linear Programming.

Live deployment: **https://smart-campus-seven-hazel.vercel.app**

---

## Quickstart

```bash
git clone <repo-url>
cd smart-campus
npm install
cp .env.example .env
# Set GEMINI_API_KEY and GEMINI_MODEL=gemini-3.5-flash in .env
npm run dev         # http://localhost:3000
```

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **Yes** | — | Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | Primary LLM model name |
| `PORT` | No | `3000` | Local server port |
| `NODE_ENV` | No | `development` | Controls `app.listen()` guard |

---

## API Endpoints

### GET /health

```bash
curl https://smart-campus-seven-hazel.vercel.app/health
```

Response:
```json
{ "status": "ok" }
```

### POST /optimize-energy

```bash
curl -X POST https://smart-campus-seven-hazel.vercel.app/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "example-01",
    "operator_notes": [
      "Facilities will wash rooftop solar panels from noon until 2 PM. Usable solar should be treated as 25% of forecast.",
      "The sports office moved next month registration deadline."
    ],
    "hours": [
      {"hour": 0, "demand_kwh": 90, "solar_kwh": 0, "tariff_bdt_per_kwh": 6},
      {"hour": 1, "demand_kwh": 85, "solar_kwh": 0, "tariff_bdt_per_kwh": 6},
      {"hour": 2, "demand_kwh": 80, "solar_kwh": 0, "tariff_bdt_per_kwh": 5},
      {"hour": 3, "demand_kwh": 80, "solar_kwh": 0, "tariff_bdt_per_kwh": 5},
      {"hour": 4, "demand_kwh": 85, "solar_kwh": 0, "tariff_bdt_per_kwh": 5},
      {"hour": 5, "demand_kwh": 95, "solar_kwh": 0, "tariff_bdt_per_kwh": 6},
      {"hour": 6, "demand_kwh": 110, "solar_kwh": 5, "tariff_bdt_per_kwh": 8},
      {"hour": 7, "demand_kwh": 130, "solar_kwh": 20, "tariff_bdt_per_kwh": 10},
      {"hour": 8, "demand_kwh": 150, "solar_kwh": 50, "tariff_bdt_per_kwh": 12},
      {"hour": 9, "demand_kwh": 165, "solar_kwh": 90, "tariff_bdt_per_kwh": 14},
      {"hour": 10, "demand_kwh": 175, "solar_kwh": 130, "tariff_bdt_per_kwh": 16},
      {"hour": 11, "demand_kwh": 180, "solar_kwh": 160, "tariff_bdt_per_kwh": 16},
      {"hour": 12, "demand_kwh": 185, "solar_kwh": 180, "tariff_bdt_per_kwh": 15},
      {"hour": 13, "demand_kwh": 180, "solar_kwh": 170, "tariff_bdt_per_kwh": 14},
      {"hour": 14, "demand_kwh": 170, "solar_kwh": 140, "tariff_bdt_per_kwh": 13},
      {"hour": 15, "demand_kwh": 165, "solar_kwh": 90, "tariff_bdt_per_kwh": 14},
      {"hour": 16, "demand_kwh": 170, "solar_kwh": 45, "tariff_bdt_per_kwh": 18},
      {"hour": 17, "demand_kwh": 185, "solar_kwh": 10, "tariff_bdt_per_kwh": 22},
      {"hour": 18, "demand_kwh": 205, "solar_kwh": 0, "tariff_bdt_per_kwh": 28},
      {"hour": 19, "demand_kwh": 215, "solar_kwh": 0, "tariff_bdt_per_kwh": 30},
      {"hour": 20, "demand_kwh": 205, "solar_kwh": 0, "tariff_bdt_per_kwh": 26},
      {"hour": 21, "demand_kwh": 175, "solar_kwh": 0, "tariff_bdt_per_kwh": 18},
      {"hour": 22, "demand_kwh": 135, "solar_kwh": 0, "tariff_bdt_per_kwh": 10},
      {"hour": 23, "demand_kwh": 105, "solar_kwh": 0, "tariff_bdt_per_kwh": 7}
    ],
    "battery": {
      "capacity_kwh": 220,
      "initial_energy_kwh": 110,
      "minimum_energy_kwh": 40,
      "max_charge_kwh_per_hour": 50,
      "max_discharge_kwh_per_hour": 50
    }
  }'
```

---

## Pipeline Architecture

```
POST /optimize-energy
  1. Zod schema validation → 400 on failure
  2. LLM interpretation (Gemini) → structured directives
  3. Deterministic guardrail sanitization → safe directives
  4. LP optimization (24h, min cost) → hourly plan
  5. Plan replay + totals recomputation → response
```

### LLM Layer — Model and Hedging Strategy

- **Provider:** Google Gemini via `@google/generative-ai`
- **Primary model:** `GEMINI_MODEL` env var (default: `gemini-3.5-flash`)
- **Hedging:** Primary model starts immediately. If no valid JSON response after **3 seconds**, secondary model is started in parallel. First valid response wins.
- **Per-model timeout:** 6 seconds
- **Total LLM hard cap:** 12 seconds
- **Max candidates:** 3 models

### Regex Fallback (Last Resort Only)

If **all** LLM model attempts fail (API down, key invalid, all 503), a deterministic regex parser handles the notes. It covers:
- `solar_reduction` — percent drop/remaining → factor
- `no_charge_window` / `no_discharge_window`
- `minimum_battery_reserve` (kWh from note)
- `max_grid_window`
- Time windows: 12h (1 PM to 3 PM), 24h (13:00), overnight wrap, "until" keyword

**The LLM is always the primary interpreter. The regex fallback only activates on complete LLM failure.**

### Guardrails

Every directive from the LLM is sanitized before reaching the optimizer:
- Invalid/unknown directive type → `no_op`
- Out-of-range hours → filtered/re-sorted
- `factor` outside `[0,1]` → clamped
- Missing `structured_adjustment` for non-no_op → `no_op`
- Duplicate `note_index` → first occurrence kept

### Optimizer (Linear Programming)

- **Library:** `javascript-lp-solver ^0.4.24`
- **Variables per hour:** `grid`, `solar`, `charge`, `discharge`, `soc`
- **Objective:** minimize `SUM(grid_h × tariff_h)`
- **Constraints:** energy balance, solar bound, battery rate limits, SOC bounds, end-of-day neutrality (`soc_23 == initial_energy_kwh`)
- **Infeasibility handling:** relaxes end-of-day by ±0.01 kWh; throws on persistent infeasibility → 500

---

## Testing

### Integration test (both endpoints)
```bash
npm test
```

### All 10 public sample cases (local server)
```bash
npm run dev &
npm run test:samples
# Against Vercel:
BASE_URL=https://smart-campus-seven-hazel.vercel.app npm run test:samples
```

---

## Docker

```bash
# Build
docker build -t gridwise-optimizer:latest .

# Run (inject secrets at runtime — never bake them in)
docker run -p 3000:3000 \
  -e GEMINI_API_KEY="your-key-here" \
  -e GEMINI_MODEL="gemini-3.5-flash" \
  gridwise-optimizer:latest

# Verify
curl http://localhost:3000/health
```

### Push to Docker Hub
```bash
docker tag gridwise-optimizer:latest <your-dockerhub-username>/gridwise-optimizer:latest
docker push <your-dockerhub-username>/gridwise-optimizer:latest
```

### Push to GitHub Container Registry (GHCR)
```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u <your-github-username> --password-stdin
docker tag gridwise-optimizer:latest ghcr.io/<your-github-username>/gridwise-optimizer:latest
docker push ghcr.io/<your-github-username>/gridwise-optimizer:latest
```

---

## Known Limitations

- **Percentage reserve vs. absolute kWh:** The LLM is given the battery `capacity_kwh` in the prompt context and instructed to convert. Hidden test notes using unusual percentage phrasings may still be misinterpreted.
- **Gemini model availability is volatile:** If all candidate models are simultaneously unavailable (503), the regex fallback activates. The regex fallback does not match all possible natural-language phrasings.
- **LP is continuous, not integer:** Charge/discharge are netted before output; simultaneous use is mathematically prevented by netting, but the LP itself has no binary exclusivity constraint.
- **Timeout budget:** Total LLM phase is capped at 12s. LP solves in <50ms. Vercel `maxDuration` is 30s.
- **No caching:** Every request makes a fresh Gemini call. High-frequency identical requests will incur full LLM latency.

---

## Credits

- **Express** — HTTP framework
- **Zod** — runtime request schema validation
- **javascript-lp-solver** — 24-hour linear program solver
- **@google/generative-ai** — Google Gemini LLM SDK
- **Google Gemini** — LLM backbone for operator note interpretation
- **AI coding assistant** — Antigravity (Google DeepMind) assisted with architecture and implementation
