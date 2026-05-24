import { type Context, Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { copilotAuthPoll, copilotAuthStart, createUpstream, deleteUpstream, listOptionalFlags, listUpstreams, testUpstream, updateUpstream } from './upstreams/routes.ts';

const adminOnlyMiddleware = async (c: Context, next: Next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Dashboard key required' }, 403);
  }
  await next();
};

export const mountControlPlane = (app: Hono) => {
  app.get('/api/health', c => c.json({ status: 'ok', service: 'floway' }));

  // Fallback while no static favicon is committed to apps/web/src/. Once
  // apps/web/src/favicon.ico lands and apps/web/build.ts copies it into dist/,
  // Workers Static Assets will match first and this handler becomes dead code.
  app.get('/favicon.ico', () => new Response(null, { status: 204 }));

  app.post('/auth/login', authLogin);
  app.post('/auth/logout', authLogout);
  app.get('/auth/me', authMe);

  const adminAuth = new Hono();
  adminAuth.use('*', adminOnlyMiddleware);
  app.route('/auth', adminAuth);

  app.get('/api/keys', listKeys);
  app.get('/api/token-usage', tokenUsage);
  app.get('/api/search-usage', searchUsage);
  app.get('/api/performance', performanceTelemetry);
  app.get('/api/performance/overview', performanceOverview);
  app.get('/api/models', controlPlaneModels);

  const adminApi = new Hono();
  adminApi.use('*', adminOnlyMiddleware);
  adminApi.post('/keys', createKey);
  adminApi.post('/keys/:id/rotate', rotateKey);
  adminApi.patch('/keys/:id', updateKey);
  adminApi.delete('/keys/:id', deleteKey);
  adminApi.get('/upstreams', listUpstreams);
  adminApi.get('/upstream-flags', listOptionalFlags);
  adminApi.post('/upstreams/copilot/auth/start', copilotAuthStart);
  adminApi.post('/upstreams/copilot/auth/poll', copilotAuthPoll);
  adminApi.post('/upstreams', createUpstream);
  adminApi.get('/upstreams/:id/copilot/quota', copilotQuota);
  adminApi.patch('/upstreams/:id', updateUpstream);
  adminApi.delete('/upstreams/:id', deleteUpstream);
  adminApi.post('/upstreams/:id/test', testUpstream);
  adminApi.get('/search-config', getSearchConfigRoute);
  adminApi.put('/search-config', putSearchConfigRoute);
  adminApi.post('/search-config/test', testSearchConfigRoute);
  adminApi.get('/export', exportData);
  adminApi.post('/import', importData);
  app.route('/api', adminApi);
};
