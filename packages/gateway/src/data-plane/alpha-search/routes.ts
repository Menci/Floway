import type { Hono } from 'hono';

import type { AuthVars, AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { mountPublicRoute } from '../public-route.ts';
import { alphaSearchPipeline } from './pipeline/index.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

const alphaSearch = (c: AuthedContext): Promise<Response> => servePipeline(c, alphaSearchPipeline, createGatewayServices);

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
