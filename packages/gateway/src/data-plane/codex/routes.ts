// Codex model-provider compatibility namespace. Codex appends `models`,
// `responses`, `responses/compact`, `images/generations`, and `images/edits`
// to this base.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/models.rs#L31-L43
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/responses.rs#L100-L102
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/compact.rs#L31-L57
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/images.rs#L33-L70
//
// The `azure-api.` marker retains Codex's remote-compaction path. It also makes
// Codex send `store: true`; remote compaction still requires this inseparable
// heuristic, while client-owned search does not consume stored search items.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/provider.rs#L106-L126
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core/src/client.rs#L890-L906
//
// Provider-scoped command auth reads the Floway token without replacing the
// account-level Codex login. Command auth is also an explicit remote-model
// refresh gate, so the provider-relative catalog still supplies context-window
// overrides and additional models.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L394-L415
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider/src/auth.rs#L166-L196

import type { Hono } from 'hono';

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
};
