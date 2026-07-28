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

import type { AuthVars } from '../../middleware/auth.ts';
import { mountAlphaSearchRoute } from '../alpha-search/routes.ts';
import { responsesHttp } from '../chat/responses/http.ts';
import { responsesWebSocket } from '../chat/responses/websocket.ts';
import { imagesEdits, imagesGenerations } from '../images/http.ts';
import { serveModels } from '../models/http.ts';
import { mountPublicRoute } from '../public-route.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

export const mountCodexRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  // Register the manifest's Codex-specific search path with the general
  // alpha-search handler.
  // https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch);
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexResponses, (method, path) => app.on(method, path, responsesHttp.generate));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexResponsesCompact, (method, path) => app.on(method, path, responsesHttp.compact));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexResponsesWebSocket, (method, path) => app.on(method, path, responsesWebSocket));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexImagesGenerations, (method, path) => app.on(method, path, imagesGenerations));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexImagesEdits, (method, path) => app.on(method, path, imagesEdits));
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.codexModels, (method, path) => app.on(method, path, serveModels));
};
