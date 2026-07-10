import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { controlPlaneRoutes } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { type AuthVars, authMiddleware } from './middleware/auth.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';
import { requestLogger } from './middleware/request-logger.ts';
import { isPublicSetupScriptRequest } from './middleware/request-path.ts';

// The public Agent Setup script endpoints are non-CORS: a `<script>`/`fetch`
// from another origin must never read the API-key-bearing body, and the machine
// that curls them is not a browser. Every other route keeps the default
// dashboard CORS. The same exact matcher that exempts them from auth exempts
// them here, so the two layers cannot disagree on what "public script" means.
const corsMiddleware = cors();

// `app` is built as a single chained expression so its TypeScript type carries
// the full path/method map that Hono RPC needs. apps/web consumes the exported
// AppType as the generic of `hc<AppType>()` to get path autocomplete and
// response-body inference. The data plane is mounted imperatively after the
// chain because apps/web does not consume data-plane routes through the RPC
// client — it talks to /v1/chat/completions etc. via plain fetch — and the
// data-plane router does not need its types preserved.
//
// The `Variables: AuthVars` generic gives every handler typed c.set / c.get
// on the three auth slots (apiKey, user, sessionId); string-key typos and
// type mismatches now fail compile instead of producing silent `any`.
export const app = new Hono<{ Variables: AuthVars }>()
  .onError(internalErrorResponse)
  .use('*', requestLogger)
  .use('*', async (c, next) => {
    if (isPublicSetupScriptRequest(c.req.method, c.req.path)) return await next();
    return await corsMiddleware(c, next);
  })
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

mountDataPlane(app);

export type AppType = typeof app;
