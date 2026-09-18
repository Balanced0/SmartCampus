import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import routes from './routes';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Mount application routes
app.use('/', routes);

// Handle 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler.
// Express 4 identifies error middleware by the 4-parameter (err, req, res, next)
// signature. Using the ErrorRequestHandler type ensures TypeScript doesn't
// silently break that contract.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[Unhandled Error]:', message);
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

export default app;
