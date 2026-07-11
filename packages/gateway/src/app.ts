import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { controlPlaneRoutes } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { type AuthVars, authMiddleware } from './middleware/auth.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';
import { isPublicSetupScriptRequest, redactSetupTokenPath } from './middleware/request-path.ts';

// The public Agent Setup script endpoints are non-CORS: a cross-origin
// `<script>`/`fetch` must never read the API-key-bearing body, and the machine
// that curls them is not a browser. The same exact matcher that exempts them
// from auth exempts them here, so the two layers cannot disagree.
const corsMiddleware = cors();

// `app` is a single chained expression so its type carries the full path/method
// map Hono RPC needs — apps/web consumes the exported AppType as the generic of
// `hc<AppType>()`. The data plane is mounted imperatively after the chain
// because apps/web reaches /v1/chat/completions etc. by plain fetch, not through
// the RPC client, so its route types need not be preserved.
export const app = new Hono<{ Variables: AuthVars }>()
  .onError(internalErrorResponse)
  // One completion line per request. The path runs through the shared redactor
  // so a setup-script token can never reach a log line.
  .use('*', async (c, next) => {
    const start = Date.now();
    await next();
    console.log(`${c.req.method} ${redactSetupTokenPath(c.req.path)} ${c.res.status} ${Date.now() - start}ms`);
  })
  .use('*', async (c, next) => {
    if (isPublicSetupScriptRequest(c.req.method, c.req.path)) return await next();
    return await corsMiddleware(c, next);
  })
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

mountDataPlane(app);

export type AppType = typeof app;
