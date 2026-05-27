import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { controlPlaneRoutes } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { authMiddleware } from './middleware/auth.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';

// `app` is built as a single chained expression so its TypeScript type carries
// the full path/method map that Hono RPC needs. apps/web consumes the exported
// AppType as the generic of `hc<AppType>()` to get path autocomplete and
// response-body inference. The data plane is mounted imperatively after the
// chain because apps/web does not consume data-plane routes through the RPC
// client — it talks to /v1/chat/completions etc. via plain fetch — and the
// data-plane router does not need its types preserved.
export const app = new Hono()
  .onError(internalErrorResponse)
  .use('*', logger())
  .use('*', cors())
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

mountDataPlane(app);

export type AppType = typeof app;
