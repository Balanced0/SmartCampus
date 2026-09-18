import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function probeModels() {
  console.log('Probing Gemini models with current API key...');
  
  // Try calling listModels via REST directly to inspect available models for this key
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log('ListModels Response Status:', res.status);
    console.log('ListModels Response:', JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error('ListModels fetch error:', e.message);
  }
}

probeModels();
