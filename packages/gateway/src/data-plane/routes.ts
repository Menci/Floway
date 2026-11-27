import type { Hono } from 'hono';

import { mountAlphaSearchRoute } from './alpha-search/route.ts';
import { mountChatRoutes } from './chat/routes.ts';
import { mountCodexRoutes } from './codex/routes.ts';
import { serveGeminiModelInfo } from './models/gemini.ts';
import { serveModels } from './models/http.ts';
import { decisionIngress, openaiAudioSpeechIngress, openaiAudioTranscriptionsIngress, openaiCompletionsIngress, openaiEmbeddingsIngress, openaiImagesEditsIngress, openaiImagesGenerationsIngress, rerankIngress } from './non-chat/index.ts';
import { mountPublicRoute } from './public-route.ts';
import { pipelineHttpHandler, pipelineHttpHandlerWithFacts } from './shared/pipeline-handler.ts';
import type { AuthVars } from '../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountDataPlane = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
  mountChatRoutes(app);
  mountCodexRoutes(app);

  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.models, (method, path) => app.on(method, path, serveModels));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiModel, (method, path) => app.on(method, path, serveGeminiModelInfo));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiEmbeddings, (method, path) => app.on(method, path, pipelineHttpHandler(openaiEmbeddingsIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiCompletions, (method, path) => app.on(method, path, pipelineHttpHandler(openaiCompletionsIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiImagesGenerations, (method, path) => app.on(method, path, pipelineHttpHandler(openaiImagesGenerationsIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiImagesEdits, (method, path) => app.on(method, path, pipelineHttpHandler(openaiImagesEditsIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiAudioSpeech, (method, path) => app.on(method, path, pipelineHttpHandler(openaiAudioSpeechIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiAudioTranscriptions, (method, path) => app.on(method, path, pipelineHttpHandler(openaiAudioTranscriptionsIngress)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV1Rerank, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(rerankIngress, facts => ({ ...facts, rerankDialect: 'cohere-v1' as const }))));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.cohereV2Rerank, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(rerankIngress, facts => ({ ...facts, rerankDialect: 'cohere-v2' as const }))));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.jinaV1Rerank, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(rerankIngress, facts => ({ ...facts, rerankDialect: 'jina-v1' as const }))));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.voyageV1Rerank, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(rerankIngress, facts => ({ ...facts, rerankDialect: 'voyage-v1' as const }))));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.typesafeSystemOne, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(decisionIngress, facts => ({ ...facts, decisionDialect: 'typesafe-systemone' as const }))));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openAiDecisions, (method, path) => app.on(method, path, pipelineHttpHandlerWithFacts(decisionIngress, facts => ({ ...facts, decisionDialect: 'openai-decisions' as const }))));
};
