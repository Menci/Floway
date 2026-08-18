import type { Hono } from 'hono';

import { mountPublicRoute } from '../public-route.ts';
import { anthropicMessagesHttp } from './anthropic-messages/http.ts';
import { geminiGenerateContentHttp } from './gemini-generate-content/http.ts';
import { openaiChatCompletionsHttp } from './openai-chat-completions/http.ts';
import { openaiResponsesHttp } from './openai-responses/http.ts';
import { openaiResponsesWebSocket } from './openai-responses/websocket.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiChatCompletions, (method, path) => app.on(method, path, openaiChatCompletionsHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponses, (method, path) => app.on(method, path, openaiResponsesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesCompact, (method, path) => app.on(method, path, openaiResponsesHttp.compact));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessages, (method, path) => app.on(method, path, anthropicMessagesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessagesCountTokens, (method, path) => app.on(method, path, anthropicMessagesHttp.countTokens));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesWebSocket, (method, path) => app.on(method, path, openaiResponsesWebSocket));
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiGenerateContentHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction, (method, path) => app.on(method, path, geminiGenerateContentHttp));
};
