import type { Hono } from 'hono';

import { mountAlphaSearchRoutes } from './alpha-search/routes.ts';
import { audioTranscriptions } from './audio/http.ts';
import { mountChatRoutes } from './chat/routes.ts';
import { mountCodexRoutes } from './codex/routes.ts';
import { completions } from './completions/http.ts';
import { embeddings } from './embeddings/http.ts';
import { imagesEdits, imagesGenerations } from './images/http.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { serveModels } from './models/http.ts';
import { rerank } from './rerank/serve.ts';
import type { AuthVars } from '../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountDataPlane = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoutes(app);
  mountChatRoutes(app);
  mountCodexRoutes(app);

  for (const path of PUBLIC_DATA_PLANE_ROUTES.models.paths) app.get(path, serveModels);
  app.get(PUBLIC_DATA_PLANE_ROUTES.geminiModels.paths[0], serveGeminiModels);
  app.get(PUBLIC_DATA_PLANE_ROUTES.geminiModel.paths[0], serveGeminiModelInfo);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.embeddings.paths) app.post(path, embeddings);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.completions.paths) app.post(path, completions);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.imagesGenerations.paths) app.post(path, imagesGenerations);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.imagesEdits.paths) app.post(path, imagesEdits);
  app.post(PUBLIC_DATA_PLANE_ROUTES.audioTranscriptions.paths[0], audioTranscriptions);
  app.post(PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank.paths[0], rerank('cohere-v1'));
  app.post(PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank.paths[0], rerank('cohere-v2'));
  app.post(PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank.paths[0], rerank('jina-v1'));
  app.post(PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank.paths[0], rerank('voyage-v1'));
};
