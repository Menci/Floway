// Codex compatibility namespace. The dashboard configures this as both its
// model-provider base and ChatGPT auxiliary base. Model calls append `models`,
// `responses`, `responses/compact`, `images/generations`, and `images/edits`.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/compact.rs#L31-L57
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/images.rs#L33-L70
//
// The `azure-api.` marker retains Codex's remote-compaction path. It also makes
// Codex send `store: true`; that remains an inseparable client heuristic even
// though client-owned search no longer needs stored web-search items.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/provider.rs#L106-L126
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core/src/client.rs#L890-L906
//
// The generated auth file puts the Floway key in ChatGPT-mode access_token.
// Codex sends it as `Authorization: Bearer <key>`, which the shared gateway
// auth middleware accepts. The same account mode enables Codex's authoritative
// model catalog and auxiliary startup flows. Codex has one account slot per
// CODEX_HOME, so the generated setup command backs up the previous file.

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
import { responsesHttp } from '../chat/responses/http.ts';
import { imagesEdits, imagesGenerations } from '../images/serve.ts';

const CODEX_BASE_PATH = '/azure-api.codex';

export const mountCodexRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  app.post(`${CODEX_BASE_PATH}/responses`, responsesHttp.generate);
  app.post(`${CODEX_BASE_PATH}/responses/compact`, responsesHttp.compact);
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
