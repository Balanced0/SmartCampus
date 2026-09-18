import app from './src/app';

const PORT = process.env.PORT || 3000;

// Vercel serverless functions import the exported app handler directly.
// Only start an HTTP listener when running standalone (local development / Docker container).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[SmartCampus] Energy Optimizer API listening on http://0.0.0.0:${PORT}`);
  });
}

export default app;
