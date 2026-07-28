import type { Hono } from 'hono';

import { chatCompletionsHttp } from './chat-completions/http.ts';
import { geminiHttp } from './gemini/http.ts';
import { messagesHttp } from './messages/http.ts';
import { responsesHttp } from './responses/http.ts';
import { responsesWebSocket } from './responses/websocket.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountChatRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  for (const path of PUBLIC_DATA_PLANE_ROUTES.chatCompletions.paths) app.post(path, chatCompletionsHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responses.paths) app.post(path, responsesHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responsesCompact.paths) app.post(path, responsesHttp.compact);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.messages.paths) app.post(path, messagesHttp.generate);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.messagesCountTokens.paths) app.post(path, messagesHttp.countTokens);
  for (const path of PUBLIC_DATA_PLANE_ROUTES.responsesWebSocket.paths) app.get(path, responsesWebSocket);
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  app.post(PUBLIC_DATA_PLANE_ROUTES.geminiAction.paths[0], geminiHttp);
};
