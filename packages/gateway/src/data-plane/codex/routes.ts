// Codex 1p-compatibility namespace.
//
// The OpenAI Codex CLI in OAuth ("ChatGPT") mode talks to two base URLs that
// must be configured side-by-side in `~/.codex/config.toml`:
//
//   chatgpt_base_url           — backend endpoints (jwks, plugins, analytics,
//                                wham, codex-namespaced catalog/compact)
//   [model_providers.x].base_url — responses endpoint
//
// Pointing both at the same prefix lets a single Floway deployment serve every
// surface codex expects. The prefix must contain an Azure marker so codex's
// `is_azure_responses_endpoint()` returns true; that unlocks `store: true` +
// `attach_item_ids` in codex's client (model-provider-info substring scan
// against `openai.azure.`, `cognitiveservices.azure.`, `aoai.azure.`,
// `azure-api.`, `azurefd.`, `windows.net/openai`), which is what restores
// ResponseItem ids on the wire so server-side state (encrypted reasoning
// content, web search results, prompt cache) is correctly bound across turns.
//
// Path-prefix split: the chat data plane is reached through `model_providers`
// and codex sends to `<provider.base_url>/responses` verbatim — no extra
// prefix. The ChatGPT-backend surface, in contrast, prefixes a `/codex/`
// segment for the catalog / analytics endpoints
// (`<chatgpt_base_url>/codex/models`, `…/codex/analytics-events/events`)
// while leaving `wham/*`, `plugins/*`, and `ps/plugins/*` directly under
// the base. The Apps MCP server lives at `/api/codex/apps` — when the
// chatgpt base contains neither `/backend-api` nor `/api/codex`, codex's
// `codex_apps_mcp_url_for_base_url`
// (codex-rs/codex-mcp/src/mcp/mod.rs:422-446) appends `/api/codex` itself
// and uses `apps` as the path; the mount below mirrors that derivation
// exactly. `responses/compact` reuses the generic `responsesHttp.compact`
// handler — codex's request shape on this path is the same one the OpenAI
// client uses against `/v1/responses/compact`, and the Copilot-aware path
// inside the generic handler synthesises an upstream-compatible response
// for backends that have no native compaction. GET on the same `/responses`
// path is the WebSocket upgrade entry — codex flips to wss when its
// `[model_providers.x].supports_websockets = true` and we mirror the
// generic `/v1/responses` WS handler so codex's session-internal item
// store works against this namespace too.
//
// `/alpha/search` is codex's web-search endpoint (codex-rs
// codex-api/src/search.rs): the CLI POSTs a `SearchRequest` when the model
// emits a `web.run` tool call and feeds the returned `output` string back to
// the model. We execute the requested commands through Floway's configured
// web-search provider instead of proxying chatgpt.com — see ./alpha-search.ts.
//
// Auth: this whole namespace is reached through the same `authMiddleware`
// that protects every other API route. The operator forges
// `~/.codex/auth.json` with `tokens.access_token` set to their Floway API
// key string; codex's `CodexAuth::get_token()` returns access_token verbatim
// and sends it as `Authorization: Bearer <key>`; `extractKey()` in
// middleware/auth.ts already accepts that header, so the namespace inherits
// API-key auth with no new code.

import type { Hono } from 'hono';

import { codexAlphaSearch, codexSearchRequestSchema } from './alpha-search.ts';
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
import { zValidator } from '../../middleware/zod-validator.ts';
import { responsesHttp } from '../chat/responses/http.ts';
import { responsesWebSocket } from '../chat/responses/websocket.ts';

const CODEX_BASE_PATH = '/azure-api.codex';

export const mountCodexRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  app.post(`${CODEX_BASE_PATH}/responses`, responsesHttp.generate);
  app.post(`${CODEX_BASE_PATH}/responses/compact`, responsesHttp.compact);
  app.get(`${CODEX_BASE_PATH}/responses`, responsesWebSocket);

  app.get(`${CODEX_BASE_PATH}/models`, codexModels);
  app.post(`${CODEX_BASE_PATH}/codex/analytics-events/events`, codexAnalyticsEventsEvents);

  app.post(`${CODEX_BASE_PATH}/alpha/search`, zValidator('json', codexSearchRequestSchema), codexAlphaSearch);

  app.post(`${CODEX_BASE_PATH}/api/codex/apps`, codexAppsMcp);

  app.get(`${CODEX_BASE_PATH}/wham/agent-identities/jwks`, codexWhamAgentIdentitiesJwks);

  app.get(`${CODEX_BASE_PATH}/plugins/featured`, codexPluginsFeatured);
  app.get(`${CODEX_BASE_PATH}/plugins/list`, codexPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/list`, codexPsPluginsList);
  app.get(`${CODEX_BASE_PATH}/ps/plugins/installed`, codexPsPluginsInstalled);
};
