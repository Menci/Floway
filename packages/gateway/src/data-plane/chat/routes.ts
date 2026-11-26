import type { Hono } from 'hono';

import { parseGeminiModelAction } from './gemini-generate-content/parse.ts';
import { openaiResponsesHttp } from './openai-responses/http.ts';
import { openaiResponsesWebSocket } from './openai-responses/websocket.ts';
import { anthropicMessagesIngress, geminiGenerateContentIngress, openAIChatCompletionsIngress } from './pipeline.ts';
import type { AuthedContext, AuthVars } from '../../middleware/auth.ts';
import { serveAnthropicMessagesCountTokens, serveGeminiGenerateContentCountTokens } from '../count-tokens/http.ts';
import { serveHttp } from '../pipeline/http.ts';
import { mountPublicRoute } from '../public-route.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

const serveOpenAIChatCompletions = serveHttp(openAIChatCompletionsIngress);
const serveAnthropicMessages = serveHttp(anthropicMessagesIngress);
const serveGeminiGenerateContent = serveHttp(geminiGenerateContentIngress);

const serveGeminiAction = async (c: AuthedContext): Promise<Response> => {
  const action = parseGeminiModelAction(c.req.url)?.action;
  return await (action === 'countTokens' ? serveGeminiGenerateContentCountTokens : serveGeminiGenerateContent)(c);
};

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiChatCompletions, (method, path) => app.on(method, path, serveOpenAIChatCompletions));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponses, (method, path) => app.on(method, path, openaiResponsesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesCompact, (method, path) => app.on(method, path, openaiResponsesHttp.compact));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessages, (method, path) => app.on(method, path, serveAnthropicMessages));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.anthropicMessagesCountTokens, (method, path) => app.on(method, path, serveAnthropicMessagesCountTokens));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.openaiResponsesWebSocket, (method, path) => app.on(method, path, openaiResponsesWebSocket));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction, (method, path) => app.on(method, path, serveGeminiAction));
};
