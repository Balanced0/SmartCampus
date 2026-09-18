import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/llm/prompts';

const TEST_NOTES = [
  // 1. Clear solar_reduction
  "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
  // 2. Clear no_charge_window
  "Battery charging is disabled from 2 AM until 5 AM for electrical maintenance.",
  // 3. Paraphrase A (same as #1: solar 25% from 12-14)
  "Expect only one-quarter of normal rooftop solar generation from 12:00 to 14:00 today.",
  // 4. Paraphrase B (same as #1: solar 75% drop / 25% remaining)
  "Solar array will experience a 75% drop in output between 12 PM and 2 PM due to heavy dust storms.",
  // 5. Paraphrase C (same as #1: solar 25% usable from 12 to 14)
  "Rooftop solar capacity is curtailed to 25% remaining output for hours 12 and 13.",
  // 6. Distractor 1 (campus-related but not energy-related)
  "The sports office moved next month's registration deadline.",
  // 7. Distractor 2 (campus-related but not energy-related)
  "The university library is extending book-return hours next week.",
  // 8. Edge case note with ambiguous or partial time reference
  "Keep at least 50% of the battery capacity stored in the battery from 6 PM until 9 PM for emergency operations."
];

const MODELS_TO_TRY = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-pro',
];

async function runStep1() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log(`[Step 1] Using GEMINI_API_KEY: ${apiKey ? apiKey.substring(0, 8) + '...' : 'NONE'}`);

  if (!apiKey) {
    console.error('ERROR: No GEMINI_API_KEY found in environment');
    process.exit(1);
  }

  const ai = new GoogleGenerativeAI(apiKey);

  for (const modelName of MODELS_TO_TRY) {
    console.log(`\nTrying model: ${modelName}...`);
    try {
      const model = ai.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const userPrompt = buildUserPrompt(TEST_NOTES);
      const response = await model.generateContent(userPrompt);
      const rawText = response.response.text();

      console.log(`\n=== RAW GEMINI API RESPONSE (${modelName}) ===\n`);
      console.log(rawText);
      console.log('\n===========================================\n');

      const parsed = JSON.parse(rawText);

      TEST_NOTES.forEach((note, idx) => {
        console.log(`\n--------------------------------------------------`);
        console.log(`[NOTE ${idx}]: "${note}"`);
        const item = parsed.find((p: any) => p.note_index === idx) || parsed[idx];
        console.log(`INTERPRETED AS:`, JSON.stringify(item, null, 2));
      });

      return; // Success, done!
    } catch (err: any) {
      console.warn(`[Model ${modelName} failed]:`, err?.message || err);
    }
  }
}

runStep1();
