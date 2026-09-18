import { GoogleGenerativeAI } from '@google/generative-ai';
import { DirectiveInterpretation } from '../types';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts';
import { parseNotesWithRegex } from './fallback_parser';

/**
 * Strip markdown code fences from LLM output.
 * Even with responseMimeType: 'application/json', some model versions
 * occasionally wrap their output in ```json ... ```.
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/, '');
  return cleaned.trim();
}

/**
 * Try to parse LLM text response into a DirectiveInterpretation array.
 * Returns null on any failure so the caller can try the next model.
 */
function tryParse(text: string): DirectiveInterpretation[] | null {
  if (!text || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(stripMarkdownFences(text));
    if (!Array.isArray(parsed)) return null;
    return parsed as DirectiveInterpretation[];
  } catch {
    return null;
  }
}

// Max 3 candidates. Primary is always first (env var or default).
const RAW_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-2.5-flash',
].filter(Boolean) as string[];
const CANDIDATE_MODELS = Array.from(new Set(RAW_CANDIDATES)).slice(0, 3);

const PER_MODEL_TIMEOUT_MS = 6000;   // 6s per model attempt
const HEDGE_DELAY_MS        = 3000;  // start second model after 3s if no result
const TOTAL_LLM_TIMEOUT_MS  = 12000; // 12s hard cap for entire LLM phase

/**
 * Make a single model call. Returns the parsed array or null.
 * Never throws — catches all errors internally.
 */
async function callModel(
  ai: GoogleGenerativeAI,
  modelName: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<DirectiveInterpretation[] | null> {
  try {
    const model = ai.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const callPromise = model.generateContent(userPrompt);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout on ${modelName}`)), PER_MODEL_TIMEOUT_MS)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);

    // Respect external abort (total deadline)
    if (signal.aborted) return null;

    return tryParse(response.response.text());
  } catch (err: any) {
    if (!signal.aborted) {
      console.warn(`[LLM] Model ${modelName} failed: ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * Run LLM interpretation with request hedging:
 *   - Start primary model immediately.
 *   - If no valid result after HEDGE_DELAY_MS, start secondary model in parallel.
 *   - Take the first valid result from either; ignore the loser.
 *   - Hard cap: TOTAL_LLM_TIMEOUT_MS across the entire phase.
 *   - On total failure: fall through to regex fallback.
 */
export async function interpretOperatorNotes(
  notes: string[],
  batteryCapacityKwh?: number
): Promise<DirectiveInterpretation[]> {
  if (!notes || notes.length === 0) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    console.warn('[LLM] GEMINI_API_KEY not set. Using regex fallback.');
    return parseNotesWithRegex(notes, batteryCapacityKwh);
  }

  const ai = new GoogleGenerativeAI(apiKey);
  const userPrompt = buildUserPrompt(notes, batteryCapacityKwh);

  // AbortController for total deadline
  const abortCtrl = new AbortController();
  const totalTimer = setTimeout(() => abortCtrl.abort(), TOTAL_LLM_TIMEOUT_MS);

  try {
    const result = await hedgedCall(ai, userPrompt, abortCtrl.signal);
    if (result) return result;
  } finally {
    clearTimeout(totalTimer);
    abortCtrl.abort(); // cancel any still-running attempts
  }

  // All models failed — use regex fallback
  console.warn('[LLM] All model attempts failed. Using regex fallback.');
  return parseNotesWithRegex(notes, batteryCapacityKwh);
}

/**
 * Hedging strategy: Primary starts immediately, secondary starts after HEDGE_DELAY_MS,
 * tertiary (if exists) starts when secondary starts.
 * First valid parse wins.
 */
async function hedgedCall(
  ai: GoogleGenerativeAI,
  userPrompt: string,
  signal: AbortSignal
): Promise<DirectiveInterpretation[] | null> {
  return new Promise((resolve) => {
    let settled = false;

    function deliver(result: DirectiveInterpretation[] | null) {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    }

    // We'll track pending models so we can resolve null when all have finished
    const pending = new Set<string>();
    function onModelDone(modelName: string, result: DirectiveInterpretation[] | null) {
      pending.delete(modelName);
      if (result) {
        deliver(result);
      } else if (pending.size === 0) {
        deliver(null);
      }
    }

    // Primary model — start immediately
    const primary = CANDIDATE_MODELS[0];
    pending.add(primary);
    callModel(ai, primary, userPrompt, signal).then((r) => onModelDone(primary, r));

    // Secondary + tertiary — start after HEDGE_DELAY_MS
    if (CANDIDATE_MODELS.length > 1) {
      const hedgeTimer = setTimeout(() => {
        if (settled) return;
        for (let i = 1; i < CANDIDATE_MODELS.length; i++) {
          const m = CANDIDATE_MODELS[i];
          pending.add(m);
          callModel(ai, m, userPrompt, signal).then((r) => onModelDone(m, r));
        }
      }, HEDGE_DELAY_MS);

      // If signal aborts (total timeout), resolve null
      signal.addEventListener('abort', () => {
        clearTimeout(hedgeTimer);
        deliver(null);
      });
    } else {
      signal.addEventListener('abort', () => deliver(null));
    }
  });
}

/**
 * Generate no_op fallback directives — used only for legacy compatibility.
 */
export function generateFallbackDirectives(
  notes: string[],
  reason: string = 'Fallback applied (LLM unavailable or unparseable)'
): DirectiveInterpretation[] {
  return notes.map((_, idx) => ({
    note_index: idx,
    applies: false,
    directive_type: 'no_op' as const,
    structured_adjustment: null,
    explanation: `${reason} for note index ${idx}`,
  }));
}
