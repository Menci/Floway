import type { Hono } from 'hono';

import { mountCodexRoutes } from './codex/routes.ts';
import { completions } from './completions/serve.ts';
import { embeddings } from './embeddings/serve.ts';
import { imagesEdits, imagesGenerations } from './images/serve.ts';
import { mountLlmRoutes } from './llm/routes.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { models } from './models/serve.ts';
import type { AuthVars } from '../middleware/auth.ts';

export const mountDataPlane = (app: Hono<{ Variables: AuthVars }>) => {
  mountLlmRoutes(app);
  mountCodexRoutes(app);

  app.get('/v1/models', models);
  app.get('/models', models);
  app.get('/v1beta/models', serveGeminiModels);
  app.get('/v1beta/models/:modelId{.+}', serveGeminiModelInfo);
  app.post('/v1/embeddings', embeddings);
  app.post('/embeddings', embeddings);
  app.post('/v1/completions', completions);
  app.post('/completions', completions);
  app.post('/v1/images/generations', imagesGenerations);
  app.post('/images/generations', imagesGenerations);
  app.post('/v1/images/edits', imagesEdits);
  app.post('/images/edits', imagesEdits);
};
