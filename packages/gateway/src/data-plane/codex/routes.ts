// Codex model-provider compatibility namespace. The dashboard configures this
// as the provider base, so Codex appends `models`, `responses`,
// `responses/compact`, `images/generations`, and `images/edits` here.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/compact.rs#L31-L57
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/endpoint/images.rs#L33-L70
//
// The `azure-api.` marker retains Codex's remote-compaction path. It also makes
// Codex send `store: true`; that remains an inseparable client heuristic even
// though client-owned search no longer needs stored web-search items.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/codex-api/src/provider.rs#L106-L126
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core/src/client.rs#L890-L906
//
// The generated provider reads `FLOWAY_API_KEY` through `env_key`. Codex sends
// it as `Authorization: Bearer <key>`, which the shared gateway auth middleware
// accepts without replacing any account-level Codex login.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L280-L299

import type { Hono } from 'hono';

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
};
