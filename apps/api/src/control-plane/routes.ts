import { type Context, Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { authLoginBody, copilotAuthPollBody, createKeyBody, createUpstreamBody, exportQuery, importBody, performanceQuery, searchConfigSchema, searchUsageQuery, tokenUsageQuery, updateKeyBody, updateUpstreamBody } from './schemas.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { copilotAuthPoll, copilotAuthStart, createUpstream, deleteUpstream, listOptionalFlags, listUpstreams, testUpstream, updateUpstream } from './upstreams/routes.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const adminOnlyMiddleware = async (c: Context, next: Next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Dashboard key required' }, 403);
  }
  await next();
};

// Chained route registration is required for Hono RPC to flow the per-path
// types into `typeof controlPlaneRoutes`, which apps/web consumes as the
// AppType generic parameter of `hc<AppType>()` to get path/method autocomplete
// and request/response inference. Each route that takes a body or query string
// declares its shape via zValidator(target, schema); the schemas live in
// ./schemas.ts and double as the RPC client's input contract.
export const controlPlaneRoutes = new Hono()
  .get('/api/health', c => c.json({ status: 'ok', service: 'floway' }))
  // Fallback while no static favicon is committed to apps/web/src/. Once
  // Vite copies a real favicon into apps/web/dist/, Workers Static Assets
  // will match first and this handler becomes dead code.
  .get('/favicon.ico', () => new Response(null, { status: 204 }))
  .post('/auth/login', zValidator('json', authLoginBody), authLogin)
  .post('/auth/logout', authLogout)
  .get('/auth/me', authMe)
  // Defensive admin guard for any /auth/* path not registered above.
  .route('/auth', new Hono().use('*', adminOnlyMiddleware))
  .get('/api/keys', listKeys)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage)
  .get('/api/performance', zValidator('query', performanceQuery), performanceTelemetry)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', controlPlaneModels)
  .route('/api', new Hono()
    .use('*', adminOnlyMiddleware)
    .post('/keys', zValidator('json', createKeyBody), createKey)
    .post('/keys/:id/rotate', rotateKey)
    .patch('/keys/:id', zValidator('json', updateKeyBody), updateKey)
    .delete('/keys/:id', deleteKey)
    .get('/upstreams', listUpstreams)
    .get('/upstream-flags', listOptionalFlags)
    .post('/upstreams/copilot/auth/start', copilotAuthStart)
    .post('/upstreams/copilot/auth/poll', zValidator('json', copilotAuthPollBody), copilotAuthPoll)
    .post('/upstreams', zValidator('json', createUpstreamBody), createUpstream)
    .get('/upstreams/:id/copilot/quota', copilotQuota)
    .patch('/upstreams/:id', zValidator('json', updateUpstreamBody), updateUpstream)
    .delete('/upstreams/:id', deleteUpstream)
    .post('/upstreams/:id/test', testUpstream)
    .get('/search-config', getSearchConfigRoute)
    .put('/search-config', zValidator('json', searchConfigSchema), putSearchConfigRoute)
    .post('/search-config/test', zValidator('json', searchConfigSchema), testSearchConfigRoute)
    .get('/export', zValidator('query', exportQuery), exportData)
    .post('/import', zValidator('json', importBody), importData));

export type ControlPlaneRoutes = typeof controlPlaneRoutes;
