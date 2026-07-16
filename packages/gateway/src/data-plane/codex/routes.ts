// Codex compatibility namespace.
//
// OAuth ("ChatGPT") mode has two independently configured bases:
//
//   chatgpt_base_url             — analytics, plugins, agent identity, Apps MCP
//   model_providers.x.base_url   — models, Responses, compaction, image requests
//
// The dashboard points both at this namespace. Codex appends `models`,
// `responses`, `responses/compact`, `images/generations`, and `images/edits`
// directly to the model-provider base:
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-api/src/endpoint/models.rs#L31-L43
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-api/src/endpoint/responses.rs#L100-L102
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-api/src/endpoint/compact.rs#L35-L57
// https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/codex-api/src/endpoint/images.rs#L33-L68
// GET on `/responses` is the WebSocket upgrade entry; POST uses the generic
// Responses handler, and `/responses/compact` uses its compaction counterpart.
// Mounting the generic WS handler here preserves its session-local item chain.
//
// The `azure-api.` marker in this prefix deliberately makes Codex classify the
// provider as Azure. Azure requests set `store: true`, which preserves
// ResponseItem IDs needed to bind encrypted reasoning, web-search results, and
// prompt-cache state across turns:
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-api/src/provider.rs#L106-L126
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/core/src/client.rs#L897-L923
//
// `chatgpt_base_url` supplies the auxiliary routes mounted below. Analytics
// appends `/codex/analytics-events/events`; Apps MCP appends `/api/codex/apps`
// when the base contains neither `/backend-api` nor `/api/codex`:
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/analytics/src/client.rs#L99-L108
// https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-mcp/src/mcp/mod.rs#L469-L490
//
// Auth: Codex reads `tokens.access_token` from `~/.codex/auth.json` and sends
// it as `Authorization: Bearer <key>`, which authMiddleware accepts as a Floway
// API key. The WebSocket binds that credential at upgrade, then re-resolves its
// key and owner before each logical request; rotating or deleting the key makes
// the next turn return 401, while upstream-scope and dump-retention changes
// take effect on the next turn.

import type { Hono } from 'hono';

import { codexAppsMcp } from './apps-mcp.ts';
import {
  codexAnalyticsEventsEvents,
  codexPluginsFeatured,
  codexPluginsList,
  codexPsPluginsInstalled,
  codexPsPluginsList,
  codexWhamAgentIdentitiesJwks,
} from './chatgpt-backend.ts';
import { codexModels } from './models.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { mountAlphaSearchRoute } from '../alpha-search/routes.ts';
import { responsesHttp } from '../chat/responses/http.ts';
import { responsesWebSocket } from '../chat/responses/websocket.ts';
import { imagesEdits, imagesGenerations } from '../images/serve.ts';

const CODEX_BASE_PATH = '/azure-api.codex';

export const mountCodexRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  // Codex appends `alpha/search` to this special provider base. Keep the path
  // owned by this namespace while reusing the general data-plane handler.
  // https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
  mountAlphaSearchRoute(app, `${CODEX_BASE_PATH}/alpha/search`);
  app.post(`${CODEX_BASE_PATH}/responses`, responsesHttp.generate);
  app.post(`${CODEX_BASE_PATH}/responses/compact`, responsesHttp.compact);
  app.get(`${CODEX_BASE_PATH}/responses`, responsesWebSocket);
  app.post(`${CODEX_BASE_PATH}/images/generations`, imagesGenerations);
  app.post(`${CODEX_BASE_PATH}/images/edits`, imagesEdits);

  app.get(`${CODEX_BASE_PATH}/models`, codexModels);
  app.post(`${CODEX_BASE_PATH}/codex/analytics-events/events`, codexAnalyticsEventsEvents);

  app.post(`${CODEX_BASE_PATH}/api/codex/apps`, codexAppsMcp);

  app.get(`${CODEX_BASE_PATH}/wham/agent-identities/jwks`, codexWhamAgentIdentitiesJwks);

  app.get(`${CODEX_BASE_PATH}/plugins/featured`, codexPluginsFeatured);
  app.get(`${CODEX_BASE_PATH}/plugins/list`, codexPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/list`, codexPsPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/installed`, codexPsPluginsInstalled);
};
