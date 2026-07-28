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
import { mountPublicRoute } from './public-route.ts';
import { rerank } from './rerank/serve.ts';
import type { AuthVars } from '../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountDataPlane = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoutes(app);
  mountChatRoutes(app);
  mountCodexRoutes(app);

  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.models, (method, path) => app.on(method, path, serveModels));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiModels, (method, path) => app.on(method, path, serveGeminiModels));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiModel, (method, path) => app.on(method, path, serveGeminiModelInfo));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.embeddings, (method, path) => app.on(method, path, embeddings));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.completions, (method, path) => app.on(method, path, completions));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.imagesGenerations, (method, path) => app.on(method, path, imagesGenerations));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.imagesEdits, (method, path) => app.on(method, path, imagesEdits));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.audioTranscriptions, (method, path) => app.on(method, path, audioTranscriptions));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank, (method, path) => app.on(method, path, rerank('cohere-v1')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank, (method, path) => app.on(method, path, rerank('cohere-v2')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank, (method, path) => app.on(method, path, rerank('jina-v1')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank, (method, path) => app.on(method, path, rerank('voyage-v1')));
};
