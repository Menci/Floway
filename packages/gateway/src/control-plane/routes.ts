import { Hono, type Next } from 'hono';

import { AGENT_SETUP_ROUTE_PATH, agentSetupControlRoutes } from './agent-setup.ts';
import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { dumpRoutes } from './dump.ts';
import { createAlias, deleteAlias, listAliases, updateAlias } from './model-aliases/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview } from './performance/routes.ts';
import { createProxy, deleteProxy, listAllBackoffs, listProxies, listProxyBackoffs, resetProxyBackoffs, testProxy, updateProxy } from './proxies/routes.ts';
import { authLoginBody, changeOwnPasswordBody, claudeCodeOauthAuthorizeUrlBody, claudeCodeOauthExchangeBody, claudeCodeOauthRefreshBody, claudeCodeProbeBody, claudeCodeSetupTokenAuthorizeUrlBody, claudeCodeSetupTokenExchangeBody, codexOauthAuthorizeUrlBody, codexOauthExchangeBody, codexOauthRefreshBody, copilotOauthDeviceLoginPollBody, copilotQuotaBody, createAliasBody, createKeyBody, createProxyBody, createUpstreamBody, createUserBody, exportQuery, importBody, listModelsBody, modelsQuery, performanceQuery, resetBackoffBody, rotateKeyBody, searchConfigSchema, searchUsageQuery, testProxyBody, tokenUsageQuery, updateAliasBody, updateKeyBody, updateProxyBody, updateUpstreamBody, updateUserBody } from './schemas.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { claudeCodeOauthAuthorizeUrl, claudeCodeOauthExchange, claudeCodeOauthRefresh, claudeCodeProbe, claudeCodeSetupTokenAuthorizeUrl, claudeCodeSetupTokenExchange, codexOauthAuthorizeUrl, codexOauthExchange, codexOauthRefresh, copilotOauthDeviceLoginPoll, copilotOauthDeviceLoginStart, copilotQuota, createUpstream, deleteUpstream, getUpstream, getUpstreamBlueprint, listModels, listOptionalFlags, listUpstreamOptions, listUpstreams, updateUpstream } from './upstreams/routes.ts';
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
  .post('/api/keys/:id/rotate', zValidator('json', rotateKeyBody), rotateKey)
  .patch('/api/keys/:id', zValidator('json', updateKeyBody), updateKey)
  .delete('/api/keys/:id', deleteKey)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', zValidator('query', modelsQuery), controlPlaneModels)
  // Minimal upstream picker exposed to non-admin users so they can scope a key
  // to specific upstreams. Returns id/name/provider/enabled only — no config,
  // no flag overrides, no model lists. Server-side validation (api-keys'
  // `upstream_ids ⊆ user.upstreamIds` check) is the real authorization gate;
  // this endpoint just feeds the picker UI.
  .get('/api/upstream-options', listUpstreamOptions)
  .route('/api/dump', dumpRoutes)
  // Per-user Agent Setup lease control routes (POST / PUT / heartbeat). Not
  // admin-gated. The public GET/HEAD setup-script routes are mounted separately
  // in app.ts, ahead of this middleware chain.
  .route(AGENT_SETUP_ROUTE_PATH, agentSetupControlRoutes)
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
    .get('/upstreams/blueprint', getUpstreamBlueprint)
    .get('/upstreams/flags', listOptionalFlags)
    .post('/upstreams/copilot/oauth/device-login/start', copilotOauthDeviceLoginStart)
    .post('/upstreams/copilot/oauth/device-login/poll', zValidator('json', copilotOauthDeviceLoginPollBody), copilotOauthDeviceLoginPoll)
    .post('/upstreams/copilot/quota', zValidator('json', copilotQuotaBody), copilotQuota)
    .post('/upstreams/codex/oauth/authorize-url', zValidator('json', codexOauthAuthorizeUrlBody), codexOauthAuthorizeUrl)
    .post('/upstreams/codex/oauth/exchange', zValidator('json', codexOauthExchangeBody), codexOauthExchange)
    .post('/upstreams/codex/oauth/refresh', zValidator('json', codexOauthRefreshBody), codexOauthRefresh)
    .post('/upstreams/claude-code/oauth/authorize-url', zValidator('json', claudeCodeOauthAuthorizeUrlBody), claudeCodeOauthAuthorizeUrl)
    .post('/upstreams/claude-code/oauth/exchange', zValidator('json', claudeCodeOauthExchangeBody), claudeCodeOauthExchange)
    .post('/upstreams/claude-code/oauth/refresh', zValidator('json', claudeCodeOauthRefreshBody), claudeCodeOauthRefresh)
    .post('/upstreams/claude-code/setup-token/authorize-url', zValidator('json', claudeCodeSetupTokenAuthorizeUrlBody), claudeCodeSetupTokenAuthorizeUrl)
    .post('/upstreams/claude-code/setup-token/exchange', zValidator('json', claudeCodeSetupTokenExchangeBody), claudeCodeSetupTokenExchange)
    .post('/upstreams/claude-code/probe', zValidator('json', claudeCodeProbeBody), claudeCodeProbe)
    .post('/upstreams/list-models', zValidator('json', listModelsBody), listModels)
    .post('/upstreams', zValidator('json', createUpstreamBody), createUpstream)
    .get('/upstreams/:id', getUpstream)
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
