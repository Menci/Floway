import type { Hono } from 'hono';

import { chatCompletionsHttp } from './chat-completions/http.ts';
import { geminiHttp } from './gemini/http.ts';
import { messagesHttp } from './messages/http.ts';
import { responsesHttp } from './responses/http.ts';
import { responsesWebSocket } from './responses/websocket.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  for (const path of PUBLIC_DATA_PLANE_ROUTES.chatCompletions.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.chatCompletions.method, path, chatCompletionsHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responses.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.responses.method, path, responsesHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responsesCompact.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.responsesCompact.method, path, responsesHttp.compact);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.messages.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.messages.method, path, messagesHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.messagesCountTokens.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.messagesCountTokens.method, path, messagesHttp.countTokens);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responsesWebSocket.paths) app.on(PUBLIC_DATA_PLANE_ROUTES.responsesWebSocket.method, path, responsesWebSocket);
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  app.on(PUBLIC_DATA_PLANE_ROUTES.geminiAction.method, PUBLIC_DATA_PLANE_ROUTES.geminiAction.paths[0], geminiHttp);
};
