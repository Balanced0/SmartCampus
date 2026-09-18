import { GoogleGenerativeAI } from '@google/generative-ai';
import { DirectiveInterpretation } from '../types';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts';

/**
 * Strip markdown code fences from LLM output.
 * Even with responseMimeType: 'application/json', some model versions
 * occasionally wrap their output in ```json ... ```. JSON.parse would
 * throw on that, so we strip fences before parsing.
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  // Remove opening fence like ```json or ```
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  // Remove closing fence
  cleaned = cleaned.replace(/\n?```\s*$/,  '');
  return cleaned.trim();
}

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro',
].filter(Boolean) as string[];

// Deduplicate candidate models
const UNIQUE_MODELS = Array.from(new Set(CANDIDATE_MODELS));

const TIMEOUT_MS = 15000; // 15s timeout to stay well within 30s Vercel budget

export function generateFallbackDirectives(
  notes: string[],
  reason: string = 'Fallback applied (LLM unavailable or unparseable)'
): DirectiveInterpretation[] {
  return notes.map((_, idx) => ({
    note_index: idx,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: `${reason} for note index ${idx}`,
  }));
}

export async function interpretOperatorNotes(
  notes: string[]
): Promise<DirectiveInterpretation[]> {
  if (!notes || notes.length === 0) {
    return [];
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    console.warn('[LLM] GEMINI_API_KEY not set. Using fallback no_op directives.');
    return generateFallbackDirectives(notes, 'GEMINI_API_KEY not configured');
  }

  const ai = new GoogleGenerativeAI(apiKey);
  const userPrompt = buildUserPrompt(notes);
  let lastError: any = null;

  for (const modelName of UNIQUE_MODELS) {
    try {
      const model = ai.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const apiPromise = model.generateContent(userPrompt);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini API call timed out on ${modelName}`)), TIMEOUT_MS)
      );

      const response = await Promise.race([apiPromise, timeoutPromise]);
      const text = response.response.text();

      if (!text || text.trim() === '') {
        console.warn(`[LLM] Empty response from Gemini (${modelName}). Trying next model.`);
        continue;
      }

      const parsed = JSON.parse(stripMarkdownFences(text));
      if (!Array.isArray(parsed)) {
        console.warn(`[LLM] Response from ${modelName} is not a JSON array. Trying next model.`);
        continue;
      }

      return parsed as DirectiveInterpretation[];
    } catch (error: any) {
      lastError = error;
      // If model not found (404), continue to next candidate model
      if (error?.message?.includes('404') || error?.message?.includes('not found')) {
        continue;
      }
      console.warn(`[LLM] Error with model ${modelName}: ${error?.message || error}`);
    }
  }

  console.warn(`[LLM] All candidate models failed (${lastError?.message || lastError}). Falling back.`);
  return generateFallbackDirectives(notes, `LLM error: ${lastError?.message || 'Unavailable'}`);
}
