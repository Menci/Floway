import type { Hono } from 'hono';

import { mountPublicRoute } from '../public-route.ts';
import { anthropicMessagesHttpOptions } from './anthropic-messages/ingress.ts';
import { geminiGenerateContentHttpOptions } from './gemini-generate-content/ingress.ts';
import { openaiChatCompletionsHttpOptions } from './openai-chat-completions/ingress.ts';
import { openAIResponsesInternalErrorBody } from './openai-responses/encode.ts';
import { createOpenAIResponsesWebSocketHandler } from './openai-responses/websocket.ts';
import {
  anthropicMessagesCountIngress, anthropicMessagesIngress, geminiGenerateContentRoute,
  openaiChatCompletionsIngress, openaiResponsesCompactIngress, openaiResponsesIngress, openaiResponsesWsIngress,
} from './wiring.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

const responsesHttpOptions = { performanceOperation: 'chat', errorStatus: (): 502 => 502, errorBody: openAIResponsesInternalErrorBody } as const;
export const openaiResponsesHandler = createGatewayHttpHandler(openaiResponsesIngress, responsesHttpOptions);
export const openaiResponsesCompactHandler = createGatewayHttpHandler(openaiResponsesCompactIngress, responsesHttpOptions);
export const openaiResponsesWebSocketHandler = createOpenAIResponsesWebSocketHandler(openaiResponsesWsIngress);

const openaiChatCompletionsHandler = createGatewayHttpHandler(openaiChatCompletionsIngress, { ...openaiChatCompletionsHttpOptions, performanceOperation: 'chat' });
const anthropicMessagesHandler = createGatewayHttpHandler(anthropicMessagesIngress, { ...anthropicMessagesHttpOptions, performanceOperation: 'chat' });
const anthropicMessagesCountHandler = createGatewayHttpHandler(anthropicMessagesCountIngress, anthropicMessagesHttpOptions);
const geminiGenerateContentHandler = createGatewayHttpHandler(geminiGenerateContentRoute, { ...geminiGenerateContentHttpOptions, performanceOperation: 'chat' });

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiChatCompletions, (method, path) => app.on(method, path, openaiChatCompletionsHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponses, (method, path) => app.on(method, path, openaiResponsesHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesCompact, (method, path) => app.on(method, path, openaiResponsesCompactHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessages, (method, path) => app.on(method, path, anthropicMessagesHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessagesCountTokens, (method, path) => app.on(method, path, anthropicMessagesCountHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesWebSocket, (method, path) => app.on(method, path, openaiResponsesWebSocketHandler));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction, (method, path) => app.on(method, path, geminiGenerateContentHandler));
};
