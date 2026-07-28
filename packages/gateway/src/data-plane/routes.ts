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

  for (const path of PUBLIC_DATA_PLANE_ROUTES.models.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.models.method, path, serveModels);
  app.on(PUBLIC_DATA_PLANE_ROUTES.geminiModels.method, PUBLIC_DATA_PLANE_ROUTES.geminiModels.paths[0], serveGeminiModels);
  app.on(PUBLIC_DATA_PLANE_ROUTES.geminiModel.method, PUBLIC_DATA_PLANE_ROUTES.geminiModel.paths[0], serveGeminiModelInfo);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.embeddings.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.embeddings.method, path, embeddings);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.completions.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.completions.method, path, completions);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.imagesGenerations.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.imagesGenerations.method, path, imagesGenerations);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.imagesEdits.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.imagesEdits.method, path, imagesEdits);
  app.on(PUBLIC_DATA_PLANE_ROUTES.audioTranscriptions.method, PUBLIC_DATA_PLANE_ROUTES.audioTranscriptions.paths[0], audioTranscriptions);
  app.on(PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank.method, PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank.paths[0], rerank('cohere-v1'));
  app.on(PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank.method, PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank.paths[0], rerank('cohere-v2'));
  app.on(PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank.method, PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank.paths[0], rerank('jina-v1'));
  app.on(PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank.method, PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank.paths[0], rerank('voyage-v1'));
};
