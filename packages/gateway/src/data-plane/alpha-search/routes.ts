import type { Hono } from 'hono';

import { alphaSearchPipeline } from './pipeline.ts';
import type { AuthVars } from '../../middleware/auth.ts';
import { serveHttp } from '../pipeline/http.ts';
import { mountPublicRoute } from '../public-route.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

const alphaSearch = serveHttp(alphaSearchPipeline);

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
