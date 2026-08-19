// Codex `/alpha/search` compatibility endpoint. The protocol itself — the request
// schema, the response shape, and the projection of Codex's settings onto the
// gateway's search filters — lives in `protocol.ts`; the chain that serves it is
// `pipeline.ts`, and `http.ts` is the seam between the two.
//
// Clients append `alpha/search` to an OpenAI-compatible provider base. The
// aliases below cover Floway's general root and `/v1` base conventions.
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
//
// The shared data-plane auth middleware guards every alias; the handler reads the
// resolved API key through the run's own prologue.

import type { Hono } from 'hono';

import { alphaSearch } from './http.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { mountPublicRoute } from '../public-route.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
