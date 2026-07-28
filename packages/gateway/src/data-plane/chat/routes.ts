import type { Hono } from 'hono';

import { mountPublicRoute } from '../public-route.ts';
import { chatCompletionsHttp } from './chat-completions/http.ts';
import { geminiHttp } from './gemini/http.ts';
import { messagesHttp } from './messages/http.ts';
import { responsesHttp } from './responses/http.ts';
import { responsesWebSocket } from './responses/websocket.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.chatCompletions, (method, path) => app.on(method, path, chatCompletionsHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.responses, (method, path) => app.on(method, path, responsesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.responsesCompact, (method, path) => app.on(method, path, responsesHttp.compact));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.messages, (method, path) => app.on(method, path, messagesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.messagesCountTokens, (method, path) => app.on(method, path, messagesHttp.countTokens));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.responsesWebSocket, (method, path) => app.on(method, path, responsesWebSocket));
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiAction, (method, path) => app.on(method, path, geminiHttp));
};
