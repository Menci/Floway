import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { agentSetupPublicRoutes } from './control-plane/agent-setup.ts';
import { controlPlaneRoutes } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { type AuthVars, authMiddleware } from './middleware/auth.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';

// `app` is a single chained expression so its type carries the full path/method
// map Hono RPC needs — apps/web consumes the exported AppType as the generic of
// `hc<AppType>()`. The data plane is mounted imperatively after the chain
// because apps/web reaches /v1/chat/completions etc. by plain fetch, not through
// the RPC client, so its route types need not be preserved.
export const app = new Hono<{ Variables: AuthVars }>()
  .onError(internalErrorResponse)
  // The public Agent Setup script endpoints reveal the selected API key as
  // executable source to an unauthenticated machine on purpose. They are mounted
  // here, structurally ahead of the logger / CORS / auth middleware below, so no
  // per-path bypass is needed in any of those layers and a lease token never
  // reaches a log line. The package seals every failure on these routes itself.
  .route('/api/setup', agentSetupPublicRoutes)
  // One completion line per request for everything that reaches the middleware
  // chain (the public script routes above already returned and are not logged).
  .use('*', async (c, next) => {
    const start = Date.now();
    await next();
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
  })
  .use('*', cors())
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

mountDataPlane(app);

export type AppType = typeof app;
