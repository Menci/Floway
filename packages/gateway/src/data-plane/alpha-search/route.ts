import type { Hono } from 'hono';

import type { AuthVars } from '../../middleware/auth.ts';
import { alphaSearchIngress } from '../non-chat/alpha-search/index.ts';
import { mountPublicRoute } from '../public-route.ts';
import { pipelineHttpHandler } from '../shared/pipeline-handler.ts';
import type { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  const handler = pipelineHttpHandler(alphaSearchIngress);
  mountPublicRoute(route, (method, path) => app.on(method, path, handler));
};
