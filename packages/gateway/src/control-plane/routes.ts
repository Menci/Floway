import { Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { cursorQuota } from './cursor-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { dumpRoutes } from './dump.ts';
import { createAlias, deleteAlias, listAliases, updateAlias } from './model-aliases/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { createProxy, deleteProxy, listAllBackoffs, listProxies, listProxyBackoffs, resetProxyBackoffs, testProxy, updateProxy } from './proxies/routes.ts';
import { authLoginBody, changeOwnPasswordBody, claudeCodeAuthorizeUrlBody, claudeCodeImportBody, claudeCodeProbeQuotaBody, claudeCodeRefreshNowBody, claudeCodeReimportBody, claudeCodeSetupTokenImportBody, claudeCodeSetupTokenReimportBody, codexAuthorizeUrlBody, codexImportBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createAliasBody, createKeyBody, createProxyBody, createUpstreamBody, createUserBody, cursorAuthorizeUrlBody, cursorPollBody, cursorReimportBody, cursorRefreshNowBody, exportQuery, fetchModelsBody, importBody, modelsQuery, performanceQuery, resetBackoffBody, searchConfigSchema, searchUsageQuery, testProxyBody, tokenUsageQuery, updateAliasBody, updateKeyBody, updateProxyBody, updateUpstreamBody, updateUserBody } from './schemas.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { claudeCodeAuthorizeUrl, claudeCodeImport, claudeCodeProbeQuota, claudeCodeRefreshNow, claudeCodeReimport, claudeCodeSetupTokenImport, claudeCodeSetupTokenReimport, codexAuthorizeUrl, codexImport, codexRefreshNow, codexReimport, copilotAuthPoll, copilotAuthStart, createUpstream, cursorAuthorizeUrl, cursorPoll, cursorReimport, cursorRefreshNow, deleteUpstream, fetchModels, listOptionalFlags, listUpstreamModels, listUpstreamOptions, listUpstreams, updateUpstream } from './upstreams/routes.ts';
import { changeOwnPassword, createUser, deleteUser, listUsers, updateUser } from './users/routes.ts';
import { type AuthedContext, type AuthVars, userFromContext } from '../middleware/auth.ts';
import { zValidator } from '../middleware/zod-validator.ts';
import { getRuntimeInfo } from '../runtime/runtime-info.ts';

const adminOnlyMiddleware = async (c: AuthedContext, next: Next) => {
  if (!userFromContext(c).isAdmin) {
    return c.json({ error: 'Admin privileges required' }, 403);
  }
  await next();
};

// Chained route registration is required so Hono flows per-path types into
// the exported `controlPlaneRoutes` type; RPC clients consume it for path/
// method autocomplete and request/response inference. The `Variables` generic
// mirrors `app.ts` so c.set / c.get stay type-checked inside every handler
// registered here (and inside the inner admin-gated sub-app).
export const controlPlaneRoutes = new Hono<{ Variables: AuthVars }>()
  .get('/api/health', c => c.json({ status: 'ok', service: 'floway' }))
  // Quiet 204 to suppress 404 noise from favicon probes; the path is
  // already in PUBLIC_PATHS so auth lets it through.
  .get('/favicon.ico', () => new Response(null, { status: 204 }))
  .post('/auth/login', zValidator('json', authLoginBody), authLogin)
  .post('/auth/logout', authLogout)
  .get('/auth/me', authMe)
  .get('/api/runtime-info', c => c.json(getRuntimeInfo(c.req.raw)))
  .get('/api/keys', listKeys)
  .post('/api/keys', zValidator('json', createKeyBody), createKey)
  .post('/api/keys/:id/rotate', rotateKey)
  .patch('/api/keys/:id', zValidator('json', updateKeyBody), updateKey)
  .delete('/api/keys/:id', deleteKey)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage)
  .get('/api/performance', zValidator('query', performanceQuery), performanceTelemetry)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', zValidator('query', modelsQuery), controlPlaneModels)
  // Minimal upstream picker exposed to non-admin users so they can scope a key
  // to specific upstreams. Returns id/name/provider/enabled only — no config,
  // no flag overrides, no model lists. Server-side validation (api-keys'
  // `upstream_ids ⊆ user.upstreamIds` check) is the real authorization gate;
  // this endpoint just feeds the picker UI.
  .get('/api/upstream-options', listUpstreamOptions)
  .route('/api/dump', dumpRoutes)
  // Self-service password change is session-only (the current-password check
  // pairs with a logged-in dashboard session); admins reset other users'
  // passwords through PATCH /api/users/:id below, which is admin-gated.
  .patch('/api/users/me/password', zValidator('json', changeOwnPasswordBody), changeOwnPassword)
  .route('/api', new Hono<{ Variables: AuthVars }>()
    .use('*', adminOnlyMiddleware)
    .get('/users', listUsers)
    .post('/users', zValidator('json', createUserBody), createUser)
    .patch('/users/:id', zValidator('json', updateUserBody), updateUser)
    .delete('/users/:id', deleteUser)
    .get('/upstreams', listUpstreams)
    .get('/upstream-flags', listOptionalFlags)
    .post('/upstreams/copilot/auth/start', copilotAuthStart)
    .post('/upstreams/copilot/auth/poll', zValidator('json', copilotAuthPollBody), copilotAuthPoll)
    .post('/upstreams/codex-authorize-url', zValidator('json', codexAuthorizeUrlBody), codexAuthorizeUrl)
    .post('/upstreams/codex-import', zValidator('json', codexImportBody), codexImport)
    .post('/upstreams/:id/codex-reimport', zValidator('json', codexReimportBody), codexReimport)
    .post('/upstreams/:id/codex-refresh-now', zValidator('json', codexRefreshNowBody), codexRefreshNow)
    .post('/upstreams/claude-code-authorize-url', zValidator('json', claudeCodeAuthorizeUrlBody), claudeCodeAuthorizeUrl)
    .post('/upstreams/claude-code-import', zValidator('json', claudeCodeImportBody), claudeCodeImport)
    .post('/upstreams/:id/claude-code-reimport', zValidator('json', claudeCodeReimportBody), claudeCodeReimport)
    .post('/upstreams/:id/claude-code-refresh-now', zValidator('json', claudeCodeRefreshNowBody), claudeCodeRefreshNow)
    .post('/upstreams/:id/claude-code-probe-quota', zValidator('json', claudeCodeProbeQuotaBody), claudeCodeProbeQuota)
    .post('/upstreams/claude-code-setup-token-import', zValidator('json', claudeCodeSetupTokenImportBody), claudeCodeSetupTokenImport)
    .post('/upstreams/:id/claude-code-setup-token-reimport', zValidator('json', claudeCodeSetupTokenReimportBody), claudeCodeSetupTokenReimport)
    .post('/upstreams/cursor-authorize-url', zValidator('json', cursorAuthorizeUrlBody), cursorAuthorizeUrl)
    .post('/upstreams/cursor-poll', zValidator('json', cursorPollBody), cursorPoll)
    .post('/upstreams/:id/cursor-reimport', zValidator('json', cursorReimportBody), cursorReimport)
    .post('/upstreams/:id/cursor-refresh-now', zValidator('json', cursorRefreshNowBody), cursorRefreshNow)
    .post('/upstreams/fetch-models', zValidator('json', fetchModelsBody), fetchModels)
    .post('/upstreams', zValidator('json', createUpstreamBody), createUpstream)
    .get('/upstreams/:id/copilot/quota', copilotQuota)
    .get('/upstreams/:id/cursor/quota', cursorQuota)
    .get('/upstreams/:id/models', listUpstreamModels)
    .patch('/upstreams/:id', zValidator('json', updateUpstreamBody), updateUpstream)
    .delete('/upstreams/:id', deleteUpstream)
    // Proxies. Literal `/proxies/backoffs` is registered before any `/:id`
    // route so Hono matches the literal segment first.
    .get('/proxies', listProxies)
    .get('/proxies/backoffs', listAllBackoffs)
    .post('/proxies', zValidator('json', createProxyBody), createProxy)
    .post('/proxies/test', zValidator('json', testProxyBody), testProxy)
    .post('/proxies/:id/backoffs/reset', zValidator('json', resetBackoffBody), resetProxyBackoffs)
    .get('/proxies/:id/backoffs', listProxyBackoffs)
    .patch('/proxies/:id', zValidator('json', updateProxyBody), updateProxy)
    .delete('/proxies/:id', deleteProxy)
    // Model aliases. Admin-only — alias config is gateway-wide tenant state,
    // and the data-plane resolver runs above prefix routing for every request.
    .get('/aliases', listAliases)
    .post('/aliases', zValidator('json', createAliasBody), createAlias)
    .put('/aliases/:name', zValidator('json', updateAliasBody), updateAlias)
    .delete('/aliases/:name', deleteAlias)
    .get('/search-config', getSearchConfigRoute)
    .put('/search-config', zValidator('json', searchConfigSchema), putSearchConfigRoute)
    .post('/search-config/test', zValidator('json', searchConfigSchema), testSearchConfigRoute)
    .get('/export', zValidator('query', exportQuery), exportData)
    .post('/import', zValidator('json', importBody), importData));

export type ControlPlaneRoutes = typeof controlPlaneRoutes;
