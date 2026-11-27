import type { Hono } from 'hono';

import { anthropicMessagesCountTokensIngress, geminiGenerateContentCountTokensIngress, openaiResponsesCompactIngress } from '../non-chat/index.ts';
import { mountPublicRoute } from '../public-route.ts';
import { pipelineHttpHandler } from '../shared/pipeline-handler.ts';
import { anthropicMessagesHttpPanicPresentation } from './anthropic-messages/http-panic.ts';
import { geminiGenerateContentHttpPanicPresentation } from './gemini-generate-content/http-panic.ts';
import { openAIChatCompletionsHttpPanicPresentation } from './openai-chat-completions/http-panic.ts';
import { openAIResponsesHttpPanicPresentation } from './openai-responses/http-panic.ts';
import { openaiResponsesWebSocket } from './openai-responses/websocket.ts';
import { anthropicMessagesHttpEntry, geminiGenerateContentHttpEntry, openaiChatCompletionsHttpEntry, openaiResponsesHttpEntry } from './pipeline/index.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiChatCompletions, (method, path) => app.on(method, path, pipelineHttpHandler(openaiChatCompletionsHttpEntry, openAIChatCompletionsHttpPanicPresentation)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponses, (method, path) => app.on(method, path, pipelineHttpHandler(openaiResponsesHttpEntry, openAIResponsesHttpPanicPresentation)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesCompact, (method, path) => app.on(method, path, pipelineHttpHandler(openaiResponsesCompactIngress, openAIResponsesHttpPanicPresentation)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessages, (method, path) => app.on(method, path, pipelineHttpHandler(anthropicMessagesHttpEntry, anthropicMessagesHttpPanicPresentation)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessagesCountTokens, (method, path) => app.on(method, path, pipelineHttpHandler(anthropicMessagesCountTokensIngress, anthropicMessagesHttpPanicPresentation)));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesWebSocket, (method, path) => app.on(method, path, openaiResponsesWebSocket));
  const generate = pipelineHttpHandler(geminiGenerateContentHttpEntry, geminiGenerateContentHttpPanicPresentation);
  const count = pipelineHttpHandler(geminiGenerateContentCountTokensIngress, geminiGenerateContentHttpPanicPresentation);
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction, (method, path) => app.on(method, path, c =>
    c.req.param('modelAction')?.endsWith(':countTokens') ? count(c) : generate(c)));
};
