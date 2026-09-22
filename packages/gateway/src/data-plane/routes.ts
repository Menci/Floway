import type { Hono } from 'hono';

import { mountAlphaSearchRoutes } from './alpha-search/routes.ts';
import { mountChatRoutes } from './chat/routes.ts';
import { mountCodexRoutes } from './codex/routes.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { serveModels } from './models/http.ts';
import { openaiAudioTranscriptions } from './openai-audio/http.ts';
import { openaiCompletions } from './openai-completions/http.ts';
import { openaiEmbeddings } from './openai-embeddings/http.ts';
import { openaiImagesEdits, openaiImagesGenerations } from './openai-images/http.ts';
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
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiEmbeddings, (method, path) => app.on(method, path, openaiEmbeddings));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiCompletions, (method, path) => app.on(method, path, openaiCompletions));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiImagesGenerations, (method, path) => app.on(method, path, openaiImagesGenerations));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiImagesEdits, (method, path) => app.on(method, path, openaiImagesEdits));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiAudioTranscriptions, (method, path) => app.on(method, path, openaiAudioTranscriptions));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank, (method, path) => app.on(method, path, rerank('cohere-v1')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank, (method, path) => app.on(method, path, rerank('cohere-v2')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank, (method, path) => app.on(method, path, rerank('jina-v1')));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank, (method, path) => app.on(method, path, rerank('voyage-v1')));
};
