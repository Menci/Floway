import type { Hono } from 'hono';

import { alphaSearchIngress } from './pipeline.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { mountPublicRoute } from '../public-route.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;
const alphaSearch = createGatewayHttpHandler(alphaSearchIngress, { errorStatus: () => 500 });

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
