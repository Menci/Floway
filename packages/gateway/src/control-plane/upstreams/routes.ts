import type { Context } from 'hono';
import type { z } from 'zod';

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamRecordToJson, type SerializedUpstreamRecord } from './serialize.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProviderInstance } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_PROXY_ID, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { shortId } from '../../shared/short-id.ts';
import { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../auth/github-device-flow.ts';
import type { claudeCodeAuthorizeUrlBody, claudeCodeImportBody, claudeCodeProbeQuotaBody, claudeCodeRefreshNowBody, claudeCodeReimportBody, claudeCodeSetupTokenImportBody, claudeCodeSetupTokenReimportBody, codexAuthorizeUrlBody, codexImportBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createUpstreamBody, fetchModelsBody, updateUpstreamBody } from '../schemas.ts';
import { copilotConfigField, type CopilotUpstreamConfig, isRecord } from '../shared/field-validators.ts';
import {
  directFetcher,
  getFlagCatalog,
  normalizeModelPrefix,
  ProviderModelsUnavailableError,
  type Fetcher,
  type ModelPrefixConfig,
  type ProxyFallbackEntry,
  type UpstreamProviderKind,
  type UpstreamRecord,
} from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import {
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamConfig,
  type ClaudeCodeUpstreamState,
  ClaudeCodeOAuthSessionTerminatedError,
  assertClaudeCodeUpstreamRecord,
  buildClaudeCodeAuthorizeUrl,
  ensureClaudeCodeAccessToken,
  fetchClaudeCodeUsageProbe,
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  importClaudeCodeFromSetupTokenCallback,
  logInfo,
  readClaudeCodeUpstreamState,
  refreshClaudeCodeAccessToken,
} from '@floway-dev/provider-claude-code';
import {
  type CodexQuotaSnapshot,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_REDIRECT_URI,
  CodexOAuthSessionTerminatedError,
  assertCodexUpstreamRecord,
  assertCodexUpstreamState,
  getCodexQuota,
  importCodexFromAuthJson,
  importCodexFromCallback,
  refreshCodexAccessToken,
} from '@floway-dev/provider-codex';
import { clearInProcessCopilotTokenCache, exchangeCopilotToken, readCopilotUpstreamState, type CopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, createOllamaProvider } from '@floway-dev/provider-ollama';

// Serialize for the HTTP response, attaching the live codex_quota snapshot
// when the row is a Codex upstream and the SWR models-cache freshness for
// every row. Keeps serialize.ts free of provider I/O and a global repo handle,
// while ensuring every response shape carries the panels the dashboard
// expects.
const serializeForResponse = async (record: UpstreamRecord): Promise<SerializedUpstreamRecord> => {
  let codexQuotaPromise: Promise<CodexQuotaSnapshot | null> | null = null;
  if (record.kind === 'codex') {
    assertCodexUpstreamRecord(record);
    codexQuotaPromise = getCodexQuota(record.id, record.config.accounts[0].chatgptAccountId);
  }
  const cacheRowPromise = getRepo().modelsCache.get(record.id);
  const cacheRow = await cacheRowPromise;
  const serialized = upstreamRecordToJson(record);
  serialized.modelsCache = {
    fetchedAt: cacheRow?.fetchedAt ?? null,
    lastError: cacheRow?.lastError ?? null,
  };
  if (codexQuotaPromise) serialized.codex_quota = await codexQuotaPromise;
  return serialized;
};

// Re-read a row after a refresh-now mutation and return the serialized
// payload, falling back to a bare `{ ok: true }` if the row vanished between
// our write and this read. Shared by both providers' refresh-now handlers.
const respondWithFreshRow = async (id: string, c: Context) => {
  const refreshed = await getRepo().upstreams.getById(id);
  return c.json(refreshed ? await serializeForResponse(refreshed) : { ok: true });
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Pulls the wire-side identifier from a provider's opaque `providerData`
// blob when the provider distinguishes between the public catalog id and
// the upstream id (e.g. claude-code exposes `claude-sonnet-4-5` publicly
// while sending `claude-sonnet-4-5-20250929` on the wire). Falls through
// to undefined when the blob is absent or lacks the field, in which case
// the caller falls back to `model.id`.
const providerDataUpstreamModelId = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = (data as { upstreamModelId?: unknown }).upstreamModelId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
};

// Run the per-provider invariant asserts on a freshly-built or freshly-merged
// record before it hits the repo. Request-time zod schemas only validate JSON
// shape; these helpers enforce the URL / endpoint-mix / path-override rules
// that the provider packages own.
const normalizeConfig = (record: UpstreamRecord): ValidationResult<unknown> => {
  try {
    if (record.kind === 'custom') return { ok: true, value: assertCustomUpstreamRecord(record).config };
    if (record.kind === 'azure') return { ok: true, value: assertAzureUpstreamRecord(record).config };
    if (record.kind === 'ollama') return { ok: true, value: assertOllamaUpstreamRecord(record).config };
    if (record.kind === 'codex') {
      assertCodexUpstreamRecord(record);
      return { ok: true, value: record.config };
    }
    if (record.kind === 'claude-code') {
      assertClaudeCodeUpstreamRecord(record);
      return { ok: true, value: record.config };
    }
    return {
      ok: true,
      value: copilotConfigField(
        record.config,
        (field, expected) => new Error(`Malformed copilot upstream config: ${field} must be ${expected}`),
      ),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const mergeConfigPatch = (provider: UpstreamProviderKind, existing: unknown, patch: unknown): ValidationResult<unknown> => {
  if (!isRecord(patch)) return { ok: false, error: 'config must be an object' };
  const next: Record<string, unknown> = {
    ...(isRecord(existing) ? structuredClone(existing) : {}),
    ...structuredClone(patch),
  };

  if (provider === 'custom') {
    if (patch.pathOverrides === null) delete next.pathOverrides;
    // Dead-field guard: a 'none' upstream must not carry a stale apiKey
    // from a previous authStyle. Always strip apiKey when the merged style
    // is 'none' so the persisted shape stays one branch of the discriminated
    // union. The reverse (switching away from 'none') is left to the
    // runtime parser, which rejects a missing apiKey when one is required.
    if (next.authStyle === 'none') delete next.apiKey;
  }
  return { ok: true, value: next };
};

// Zod validates `prefix` regex/length and `addressable.nonempty()`, but the
// `listed ⊆ addressable` clamp and form-order canonicalisation live in
// `normalizeModelPrefix`. Wrap it in the same ValidationResult shape the
// sibling normalizers (normalizeConfig, mergeConfigPatch) use so the route
// handlers stay uniform.
const normalizeModelPrefixField = (input: unknown): ValidationResult<ModelPrefixConfig | null> => {
  try {
    return { ok: true, value: normalizeModelPrefix(input) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

const newId = (): string => shortId('up');

const nextSortOrder = (upstreams: readonly UpstreamRecord[]): number => upstreams.reduce((acc, upstream) => Math.max(acc, upstream.sortOrder), -1) + 1;

// Synchronously populate the SWR models cache for a freshly-saved upstream
// so the dashboard's next navigation lands on a populated row. Upstream
// fetch failures are persisted to the row's `lastError` by runFetch and
// surfaced by the dashboard, so we discard the throw here. Provider
// instance and fetcher construction errors are not swallowed; those signal
// genuine misconfiguration that the operator must see.
const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<void> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const instance = await createProviderInstance(record);
  const fetcher = (await createPerRequestFetcher(getCurrentColo(c.req.raw)))(record.id);
  try {
    await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: true });
  } catch {}
};

// 'direct' is always a valid entry id; any other id must reference an
// existing proxy row. List order matters at dial time (see createFetcher),
// and persistence layers dedupe via normalizeProxyFallbackList before
// storing.
const validateProxyFallbackList = async (entries: readonly ProxyFallbackEntry[]): Promise<{ ok: true } | { ok: false; error: string }> => {
  const ids = entries.map(e => e.id).filter(id => id !== DIRECT_PROXY_ID);
  if (ids.length === 0) return { ok: true };
  const proxies = await getRepo().proxies.list();
  const known = new Set(proxies.map(p => p.id));
  for (const id of ids) {
    if (!known.has(id)) return { ok: false, error: `unknown proxy id in fallback list: ${id}` };
  }
  return { ok: true };
};

export const listUpstreams = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(await Promise.all(items.map(serializeForResponse)));
};

// Picker dataset for the per-key upstream whitelist editor. Non-admin users
// need to know which upstreams exist to scope their keys, but they must not
// see operator-tuned config (model lists, flag overrides, copilot user info,
// etc.). This minimal projection is the only upstream surface mounted outside
// the admin zone.
export const listUpstreamOptions = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(upstream => ({
      id: upstream.id,
      name: upstream.name,
      kind: upstream.kind,
      enabled: upstream.enabled,
    })));
};

export const listOptionalFlags = (c: Context) => c.json(getFlagCatalog());

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

  // Codex credentials carry an OAuth refresh_token + id_token-derived identity
  // that this endpoint cannot synthesize. Route the operator to the dedicated
  // PKCE / import flow instead of letting a `kind: 'codex'` body through
  // with no credential material.
  if (body.kind === 'codex') {
    return c.json({ error: 'Use POST /api/upstreams/codex-import for codex provider' }, 400);
  }
  // Same rationale for claude-code: the row carries an OAuth refresh token and
  // an identity derived from /api/oauth/profile, neither of which is
  // synthesizable from a plain POST.
  if (body.kind === 'claude-code') {
    return c.json({ error: 'Use POST /api/upstreams/claude-code-import for claude-code provider' }, 400);
  }

  const proxyFallbackList = normalizeProxyFallbackList(body.proxy_fallback_list ?? []);
  const fallbackCheck = await validateProxyFallbackList(proxyFallbackList);
  if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);

  const modelPrefixResult = normalizeModelPrefixField(body.model_prefix);
  if (!modelPrefixResult.ok) return c.json({ error: modelPrefixResult.error }, 400);
  const modelPrefix = modelPrefixResult.value;

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const upstream: UpstreamRecord = {
    id: newId(),
    kind: body.kind,
    name: body.name,
    enabled: body.enabled ?? true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    proxyFallbackList,
    modelPrefix,
    config: body.config,
    state: null,
  };

  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  const record = { ...upstream, config: config.value };
  await getRepo().upstreams.save(record);
  await warmModelsCache(record, c);
  return c.json(await serializeForResponse(record), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = c.req.valid('json');
  if (body.kind !== undefined && body.kind !== existing.kind) {
    return c.json({ error: 'kind cannot be changed' }, 400);
  }

  // Codex `config` (id_token-derived identity) and credential state are
  // owned by the dedicated re-import / refresh endpoints. Generic PATCH still
  // adjusts the surrounding row metadata (name, enabled, sort_order, flag
  // overrides, disabled model ids) but never the credential payload.
  if (existing.kind === 'codex' && body.config !== undefined) {
    return c.json({ error: 'Use POST /api/upstreams/:id/codex-reimport to update codex credentials' }, 400);
  }
  // Same gate for claude-code: identity comes from /api/oauth/profile at
  // import time and the credential state belongs to refresh-now / re-import,
  // not a generic field patch.
  if (existing.kind === 'claude-code' && body.config !== undefined) {
    return c.json({ error: 'Use POST /api/upstreams/:id/claude-code-reimport to update claude-code credentials' }, 400);
  }

  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.sort_order !== undefined) next = { ...next, sortOrder: body.sort_order };
  if (body.flag_overrides !== undefined) next = { ...next, flagOverrides: body.flag_overrides };
  if (body.disabled_public_model_ids !== undefined) next = { ...next, disabledPublicModelIds: body.disabled_public_model_ids };
  if (body.proxy_fallback_list !== undefined) {
    const normalized = normalizeProxyFallbackList(body.proxy_fallback_list);
    const fallbackCheck = await validateProxyFallbackList(normalized);
    if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);
    next = { ...next, proxyFallbackList: normalized };
  }
  if (body.model_prefix !== undefined) {
    const result = normalizeModelPrefixField(body.model_prefix);
    if (!result.ok) return c.json({ error: result.error }, 400);
    next = { ...next, modelPrefix: result.value };
  }
  if (body.config !== undefined) {
    const config = mergeConfigPatch(existing.kind, existing.config, body.config);
    if (!config.ok) return c.json({ error: config.error }, 400);
    next = { ...next, config: config.value };
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };

  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

export const deleteUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const repo = getRepo();
  const deleted = await repo.upstreams.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  // No FK from proxy_upstream_backoffs to upstreams; clean up explicitly.
  await repo.proxyBackoffs.resetForUpstream(id);
  return c.json({ ok: true });
};

// Browse the live `/models` list of a DRAFT (unsaved) upstream so the editor
// can pick models before saving. Saved upstreams use
// GET /api/upstreams/:id/models?refresh=true instead, which routes through
// the SWR cache.
//
// Custom returns the raw upstream `/models` response verbatim — the dashboard
// applies the per-draft endpoints map to translate each row into a manual
// override candidate. Ollama returns already-projected `UpstreamModelConfig`
// rows, since the per-model endpoints fall out of the per-model `capabilities`
// the upstream itself reports.
export const fetchModels = async (c: CtxWithJson<typeof fetchModelsBody>) => {
  const body = c.req.valid('json');
  if (body.id !== undefined) {
    return c.json({
      error: { message: 'use GET /api/upstreams/:id/models?refresh=true for saved upstreams', type: 'invalid_request_error' },
    }, 400);
  }

  const now = new Date().toISOString();
  const record: UpstreamRecord = {
    id: newId(),
    kind: body.kind,
    name: `Draft ${body.kind} upstream`,
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    config: body.config,
    state: null,
  };

  try {
    if (body.kind === 'custom') {
      const assertedConfig = assertCustomUpstreamRecord(record).config;
      const result = await fetchCustomModels(assertedConfig, directFetcher);
      return c.json(result);
    }
    // body.kind === 'ollama' — the provider's own getProvidedModels
    // already projects /api/tags + /api/show into ProviderModel; reshape each
    // into UpstreamModelConfig so the dashboard can drop them straight into
    // the auto rows without re-deriving endpoints from capabilities.
    assertOllamaUpstreamRecord(record);
    const instance = createOllamaProvider(record);
    const models = await instance.instance.getProvidedModels(directFetcher);
    const data = models.map(model => {
      const upstreamModelId = model.providerData as string;
      const config: Record<string, unknown> = {
        upstreamModelId,
        publicModelId: model.id,
        kind: model.kind,
        endpoints: model.endpoints,
      };
      if (model.display_name !== undefined) config.display_name = model.display_name;
      if (Object.keys(model.limits).length > 0) config.limits = model.limits;
      if (model.cost) config.cost = model.cost;
      return config;
    });
    return c.json({ data });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    if (e instanceof Error && /Malformed .* upstream config/.test(e.message)) {
      return c.json({ error: errorMessage(e) }, 400);
    }
    throw e;
  }
};

// List the resolved model catalog of a SAVED upstream (any provider). A
// read-only view for the dashboard — Copilot's catalog in particular is fixed
// by the upstream and the operator cannot edit it. Routes through the SWR
// models cache; `?refresh=true` forces a fresh upstream fetch.
export const listUpstreamModels = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const record = await getRepo().upstreams.getById(id);
  if (!record) return c.json({ error: 'upstream not found' }, 404);

  const refresh = c.req.query('refresh') === 'true';
  const scheduler = backgroundSchedulerFromContext(c);
  const fetcher = (await createPerRequestFetcher(getCurrentColo(c.req.raw)))(record.id);

  try {
    const instance = await createProviderInstance(record);
    const models = await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: refresh });
    const data = models.map(model => ({
      upstreamModelId: providerDataUpstreamModelId(model.providerData) ?? model.id,
      publicModelId: model.id,
      kind: model.kind,
      endpoints: model.endpoints,
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
      ...(model.cost ? { cost: model.cost } : {}),
      ...(model.chat ? { chat: model.chat } : {}),
    }));
    return c.json({ data });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    throw e;
  }
};

export const copilotAuthStart = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

const copilotConfigUserId = (config: unknown): number | null => {
  if (!isRecord(config) || !isRecord(config.user)) return null;
  return typeof config.user.id === 'number' && Number.isSafeInteger(config.user.id) ? config.user.id : null;
};

// The body's optional `proxy_fallback_list` is the operator's in-progress
// edit-form override, forwarded into every GitHub-side fetch so the device
// flow lands through the same proxy chain they're configuring.
export const copilotAuthPoll = async (c: CtxWithJson<typeof copilotAuthPollBody>) => {
  try {
    const { device_code: deviceCode, proxy_fallback_list: proxyFallbackList } = c.req.valid('json');
    const fetcher = await resolveControlPlaneFetcher({ override: proxyFallbackList, currentColo: getCurrentColo(c.req.raw) });

    const data = await pollGitHubDeviceFlow(deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down', interval: data.interval });
    if (data.error) return c.json({ status: 'error', error: data.error_description ?? data.error }, 400);

    if (!data.access_token) return c.json({ status: 'error', error: 'Unknown response' }, 500);

    const user = await fetchGitHubUser(data.access_token, fetcher);
    // Seed state with a token now so the upstream is immediately usable and
    // dashboard knows the per-tier `endpoints.api` GitHub routes this PAT to.
    // Also validates the PAT — a bad token throws before we touch the repo.
    const tokenEntry = await exchangeCopilotToken(data.access_token, fetcher);

    const repo = getRepo().upstreams;
    const upstreams = await repo.list();
    const existing = upstreams.find(upstream => upstream.kind === 'copilot' && copilotConfigUserId(upstream.config) === user.id);
    const now = new Date().toISOString();
    const config: CopilotUpstreamConfig = {
      githubToken: data.access_token,
      user,
    };
    const prevState = existing ? readCopilotUpstreamState(existing.state) : { knownModels: null, copilotToken: null };
    const nextState: CopilotUpstreamState = {
      ...prevState,
      copilotToken: tokenEntry,
    };

    const record: UpstreamRecord = existing
      ? {
          ...existing,
          config,
          updatedAt: now,
          state: nextState,
        }
      : {
          id: newId(),
          kind: 'copilot',
          name: user.login ? `GitHub Copilot (${user.login})` : 'GitHub Copilot',
          enabled: true,
          sortOrder: nextSortOrder(upstreams),
          createdAt: now,
          updatedAt: now,
          flagOverrides: {},
          disabledPublicModelIds: [],
          // Persist the override on initial create so subsequent data-plane
          // calls honor the same chain. Existing rows keep their stored
          // list — the override above already routes the poll itself
          // correctly without clobbering a prior persisted choice.
          proxyFallbackList: proxyFallbackList !== undefined ? normalizeProxyFallbackList(proxyFallbackList) : [],
          modelPrefix: null,
          config,
          state: nextState,
        };

    await repo.save(record);
    // Drop the in-process memo so any isolate that already held a token entry
    // for this upstream id (from a prior rotation) re-hydrates from the fresh
    // state we just wrote, rather than serving up to 60s of stale auth.
    // Persisted state stays — we just put a freshly minted token there.
    clearInProcessCopilotTokenCache();
    await warmModelsCache(record, c);
    return c.json({ status: 'complete', user, upstream: await serializeForResponse(record) });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

// Stateless authorize-URL builder. PKCE state is owned by the dashboard
// (verifier + state are generated client-side and stashed in sessionStorage);
// the server only stamps the SPA-provided `challenge` and `state` into the
// authorize URL with the auth.openai.com flags codex-cli sets.
//   * `id_token_add_organizations` enriches the id_token with the operator's
//     chatgpt_account_id; without it the identity-parsing step in
//     `importCodexFromCallback` throws.
//   * `codex_cli_simplified_flow` skips the consent screen for already-
//     authorized clients.
//   * `originator` matches the data-plane originator so auth telemetry stays
//     consistent.
export const codexAuthorizeUrl = async (c: CtxWithJson<typeof codexAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');

  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');

  return c.json({ authorize_url: url.toString() });
};

type CodexCredentialBody = z.infer<typeof codexImportBody> | z.infer<typeof codexReimportBody>;

const ingestCodexCredential = async (
  body: CodexCredentialBody,
  fetcher: Fetcher,
): Promise<{ ok: true; config: CodexUpstreamConfig; state: CodexUpstreamState } | { ok: false; error: string }> => {
  try {
    if (body.auth_json !== undefined) {
      // auth_json ingest parses the JWT locally; no network call uses the
      // fetcher, so it is intentionally not threaded here.
      const out = await importCodexFromAuthJson(body.auth_json);
      return { ok: true, ...out };
    }
    const cb = body.callback;
    if (!cb) return { ok: false, error: 'callback is required when auth_json is absent' };
    const out = await importCodexFromCallback({ code: cb.code, codeVerifier: cb.verifier, fetcher });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

export const codexImport = async (c: CtxWithJson<typeof codexImportBody>) => {
  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    // First-time import has no upstream id, so the resolver falls back to
    // direct egress when the operator left the override empty.
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestCodexCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  // `parseCodexIdTokenClaims` already rejects tokens with a missing email,
  // so the email field is non-empty by the time we get here.
  const defaultName = `ChatGPT Codex (${ingestion.config.accounts[0].email})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    kind: 'codex',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    // Persist the in-flight override so subsequent data-plane calls route
    // through the same chain without an extra edit step.
    proxyFallbackList: body.proxy_fallback_list !== undefined ? normalizeProxyFallbackList(body.proxy_fallback_list) : [],
    modelPrefix: null,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  await warmModelsCache(upstream, c);
  return c.json(await serializeForResponse(upstream), 201);
};

export const codexReimport = async (c: CtxWithJson<typeof codexReimportBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.kind !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }

  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    // Re-import threads the override through the same resolver as
    // `codexRefreshNow`; absent falls back to the persisted row's list.
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestCodexCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    // Re-import accepts an in-flight proxy override; when present, overwrite
    // the persisted list so subsequent data-plane calls match the chain the
    // operator just used for re-import. Absent override leaves the
    // persisted list untouched.
    proxyFallbackList: body.proxy_fallback_list !== undefined
      ? normalizeProxyFallbackList(body.proxy_fallback_list)
      : existing.proxyFallbackList,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

// The body carries an optional `proxy_fallback_list` override so a refresh
// fired from an unsaved edit-form uses the in-progress chain rather than
// the persisted one. See proxy-resolution.ts for the layered policy.
export const codexRefreshNow = async (c: CtxWithJson<typeof codexRefreshNowBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.kind !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }
  // A throw from assertCodexUpstreamState means the row's state column was
  // hand-edited or otherwise corrupted — the framework-level 500
  // handler stack-traces internally without surfacing the parse error to the
  // dashboard.
  assertCodexUpstreamState(existing.state);
  const state = existing.state;
  // The state schema enforces exactly one account; refresh-now mutates that
  // single entry.
  const account = state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-import to recover` }, 400);
  }

  const body = c.req.valid('json');
  let fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const tokens = await refreshCodexAccessToken(account.refresh_token, fetcher);
    const now = new Date();
    const nextAccount = {
      ...account,
      refresh_token: tokens.refresh_token,
      // Keep `state_updated_at` untouched on a successful refresh — the row's
      // credential-health status hasn't changed (still 'active'), and bumping
      // the timestamp on every refresh would muddy the dashboard's "credential
      // health changed" signal. Matches `claudeCodeRefreshNow` and both
      // providers' data-plane refresh paths in `access-token-cache.ts`.
      accessToken: {
        token: tokens.access_token,
        expiresAt: now.getTime() + tokens.expires_in * 1000,
        refreshedAt: now.toISOString(),
      },
    };
    const nextState: CodexUpstreamState = { accounts: [nextAccount] };
    // CAS keyed on the just-read state. A losing race here means a concurrent
    // data-plane refresh already rotated the row; their write is at least as
    // fresh as ours, so we surface 409 rather than retry.
    const result = await getRepo().upstreams.saveState(id, nextState, { expectedState: state });
    if (!result.updated) {
      return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
    }
    return await respondWithFreshRow(id, c);
  } catch (err) {
    // OAuth session terminated (refresh_token replayed, revoked, or
    // app_session_terminated): mirror the data-plane behavior — flip the row
    // to `refresh_failed` so the dashboard surfaces the red badge and the
    // operator sees a Re-import affordance instead of a stale Refresh button.
    if (err instanceof CodexOAuthSessionTerminatedError) {
      const failedAccount = {
        ...account,
        state: 'refresh_failed' as const,
        state_message: err.upstreamMessage,
        state_updated_at: new Date().toISOString(),
        // Refresh failure invalidates whatever access token still sat in state;
        // even if the data-plane somehow bypassed the active-state gate, the
        // cached token wouldn't outlive the refresh failure for long.
        accessToken: null,
      };
      const failedState: CodexUpstreamState = { accounts: [failedAccount] };
      // Best-effort: a losing CAS means a concurrent rotation already wrote
      // newer state, which by definition supersedes ours.
      await getRepo().upstreams.saveState(id, failedState, { expectedState: state });
      // 400, not 502: the upstream IS answering — it's telling us the stored
      // refresh token is dead. That's a client-side credential problem, not
      // an upstream outage. 401 is wrong too: the dashboard's auth client
      // logs the operator out on any 401 (apps/web/src/api/client.ts), and
      // a "your codex credential is dead" condition must not be confused
      // with "your dashboard auth is invalid".
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-import the credential to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }
};

// Stateless authorize-URL builder shared by both OAuth and Setup-Token
// import flows. PKCE state is owned by the dashboard (verifier + state are
// generated client-side and stashed in sessionStorage); the server only
// stamps the SPA-provided `challenge` and `state` into the authorize URL.
// The `kind` discriminator selects the scope set — full OAuth versus the
// inference-only `user:inference` scope. Both kinds share host /
// client_id / redirect_uri / token endpoint; only the authorize-URL scope
// differs.
export const claudeCodeAuthorizeUrl = async (c: CtxWithJson<typeof claudeCodeAuthorizeUrlBody>) => {
  const { challenge, state, kind } = c.req.valid('json');
  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge, kind });
  return c.json({ authorize_url });
};

type ClaudeCodeCredentialBody = z.infer<typeof claudeCodeImportBody> | z.infer<typeof claudeCodeReimportBody>;
type ClaudeCodeSetupTokenBody = z.infer<typeof claudeCodeSetupTokenImportBody> | z.infer<typeof claudeCodeSetupTokenReimportBody>;

const ingestClaudeCodeCredential = async (
  body: ClaudeCodeCredentialBody,
  fetcher: Fetcher,
): Promise<{ ok: true; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState } | { ok: false; error: string }> => {
  if (body.credentials_json === undefined && body.callback === undefined) {
    throw new Error('claudeCode ingest: callback missing despite Zod refine — schema/validation drift');
  }
  try {
    if (body.credentials_json !== undefined) {
      const out = await importClaudeCodeFromCredentialsJson(body.credentials_json, fetcher);
      return { ok: true, ...out };
    }
    const cb = body.callback!;
    const out = await importClaudeCodeFromCallback({ code: cb.code, pkceVerifier: cb.verifier, state: cb.state, fetcher });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

const ingestClaudeCodeSetupTokenCredential = async (
  body: ClaudeCodeSetupTokenBody,
  fetcher: Fetcher,
): Promise<{ ok: true; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState } | { ok: false; error: string }> => {
  try {
    const out = await importClaudeCodeFromSetupTokenCallback({
      code: body.callback.code,
      pkceVerifier: body.callback.verifier,
      state: body.callback.state,
      fetcher,
    });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

export const claudeCodeImport = async (c: CtxWithJson<typeof claudeCodeImportBody>) => {
  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const defaultName = `Claude Code (${ingestion.config.accounts[0].email})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    kind: 'claude-code',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    // Persist the in-flight override so subsequent data-plane calls route
    // through the same chain without an extra edit step.
    proxyFallbackList: body.proxy_fallback_list !== undefined ? normalizeProxyFallbackList(body.proxy_fallback_list) : [],
    modelPrefix: null,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  await warmModelsCache(upstream, c);
  return c.json(await serializeForResponse(upstream), 201);
};

export const claudeCodeReimport = async (c: CtxWithJson<typeof claudeCodeReimportBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.kind !== 'claude-code') {
    return c.json({ error: 'Claude Code upstream not found' }, 404);
  }
  // Cross-kind re-import would silently replace a setup-token credential
  // with an OAuth refresh token (or vice versa), changing the credential's
  // capability surface (`user:profile` scope, presence of refresh) without
  // a corresponding name / type change on the dashboard. Reject so the
  // operator picks the right re-import endpoint.
  const currentAccount = readClaudeCodeUpstreamState(existing.state).accounts[0];
  if (currentAccount.tokenKind === 'setup-token') {
    return c.json({ error: 'row uses setup-token credential; use /claude-code-setup-token-reimport' }, 400);
  }

  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    // Re-import accepts an in-flight proxy override; when present, overwrite
    // the persisted list so subsequent data-plane calls match the chain the
    // operator just used for re-import. Absent override leaves the
    // persisted list untouched.
    proxyFallbackList: body.proxy_fallback_list !== undefined
      ? normalizeProxyFallbackList(body.proxy_fallback_list)
      : existing.proxyFallbackList,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

export const claudeCodeSetupTokenImport = async (c: CtxWithJson<typeof claudeCodeSetupTokenImportBody>) => {
  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeSetupTokenCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  // The default name for setup-token imports falls back to the short account
  // id because the bearer lacks `user:profile` and the email is null. The
  // dashboard surfaces the same id as a header for setup-token cards.
  const account = ingestion.config.accounts[0];
  const defaultName = `Claude Code Setup Token (${account.email ?? account.accountUuid.slice(0, 8)})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    kind: 'claude-code',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: body.proxy_fallback_list !== undefined ? normalizeProxyFallbackList(body.proxy_fallback_list) : [],
    modelPrefix: null,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  await warmModelsCache(upstream, c);
  return c.json(await serializeForResponse(upstream), 201);
};

export const claudeCodeSetupTokenReimport = async (c: CtxWithJson<typeof claudeCodeSetupTokenReimportBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.kind !== 'claude-code') {
    return c.json({ error: 'Claude Code upstream not found' }, 404);
  }
  // Symmetric guard to claudeCodeReimport: an OAuth row must not be replaced
  // with a setup token through the setup-token endpoint.
  const currentAccount = readClaudeCodeUpstreamState(existing.state).accounts[0];
  if (currentAccount.tokenKind === 'oauth') {
    return c.json({ error: 'row uses oauth credential; use /claude-code-reimport' }, 400);
  }

  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  const ingestion = await ingestClaudeCodeSetupTokenCredential(body, fetcher);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    proxyFallbackList: body.proxy_fallback_list !== undefined
      ? normalizeProxyFallbackList(body.proxy_fallback_list)
      : existing.proxyFallbackList,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await warmModelsCache(next, c);
  return c.json(await serializeForResponse(next));
};

// Same freshness skew as the access-token cache (access-token-cache.ts):
// a sibling-minted access token within this much of expiry is treated as
// "not fresh enough to surface as success" and triggers the recovery
// re-mint path.
const CLAUDE_CODE_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Re-reads the row after a losing refresh attempt and decides what the
// operator actually observed. Three outcomes:
//   - 'recovered': sibling already rotated and wrote a fresh access token —
//     the operator's refresh is effectively done.
//   - 'retry-mint': sibling rotated the RT but the access token slot is
//     empty (e.g. a concurrent invalidateClaudeCodeAccessToken cleared it);
//     re-enter the refresh once with the live RT.
//   - 'genuine-failure': nobody rotated, or the row flipped to terminal.
//     Caller falls through to the terminal-flip path.
//
// Mirrors `recoverFromRefreshRace` in
// `packages/provider-claude-code/src/access-token-cache.ts` but lighter:
// the data-plane recovery has to return a usable token to keep the
// request flowing, while here we only need to decide whether the
// dashboard sees "refresh succeeded" or "refresh failed."
const recoverRefreshNow = async (
  id: string,
  refreshTokenWeUsed: string,
): Promise<'recovered' | 'retry-mint' | 'genuine-failure'> => {
  const reread = await getRepo().upstreams.getById(id);
  if (!reread) return 'genuine-failure';
  const rereadAccount = readClaudeCodeUpstreamState(reread.state).accounts[0];
  // Sibling already flipped to terminal, or the row was hand-mutated away
  // from active. Either way, no recovery to report.
  if (rereadAccount.state !== 'active') return 'genuine-failure';
  if (rereadAccount.tokenKind !== 'oauth') return 'genuine-failure';
  // RT unchanged: nobody else rotated. If the upstream said invalid_grant
  // on our RT, the credential really is dead.
  if (rereadAccount.refreshToken === refreshTokenWeUsed) return 'genuine-failure';

  if (
    rereadAccount.accessToken
    && rereadAccount.accessToken.expiresAt > Date.now() + CLAUDE_CODE_REFRESH_SKEW_MS
  ) {
    console.info(
      `Claude Code refresh-now recovered for upstream ${id}: sibling rotated, surfacing their access token`,
    );
    return 'recovered';
  }
  return 'retry-mint';
};

// One attempt at a refresh round-trip + CAS write. Re-reads the row at the
// start so a recovery re-mint picks up the sibling-rotated RT instead of
// replaying our stale copy.
type RefreshAttempt =
  | { kind: 'ok' }
  | { kind: 'cas-lost'; refreshTokenUsed: string }
  | { kind: 'oauth-terminal'; error: ClaudeCodeOAuthSessionTerminatedError; refreshTokenUsed: string; baselineRaw: unknown; baselineAccount: ClaudeCodeAccountCredential };

const attemptClaudeCodeRefresh = async (id: string, fetcher: Fetcher): Promise<RefreshAttempt> => {
  const fresh = await getRepo().upstreams.getById(id);
  if (!fresh) throw new Error(`Claude Code upstream ${id} disappeared mid-refresh`);
  const account = readClaudeCodeUpstreamState(fresh.state).accounts[0];
  if (account.state !== 'active' || account.tokenKind !== 'oauth') {
    throw new Error(`Claude Code upstream ${id} no longer eligible for refresh mid-attempt`);
  }

  let tokens;
  try {
    tokens = await refreshClaudeCodeAccessToken(account.refreshToken, fetcher);
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return { kind: 'oauth-terminal', error: err, refreshTokenUsed: account.refreshToken, baselineRaw: fresh.state, baselineAccount: account };
    }
    throw err;
  }
  // The refresh round-trip always carries a refresh_token; guard for shape
  // drift so a malformed upstream response can't corrupt the persisted row.
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token === '') {
    throw new Error('Claude Code OAuth /token response missing refresh_token on refresh');
  }
  const now = new Date();
  const nextAccount: ClaudeCodeAccountCredential = {
    ...account,
    refreshToken: tokens.refresh_token,
    // Keep `state` untouched on a successful refresh — 'active' is already
    // the value we want and bumping stateUpdatedAt on every refresh would
    // muddy the dashboard's "credential health changed" signal. Match the
    // access-token cache's behavior in the data-plane hot path.
    accessToken: {
      token: tokens.access_token,
      expiresAt: now.getTime() + tokens.expires_in * 1000,
      refreshedAt: now.toISOString(),
    },
  };
  const nextState: ClaudeCodeUpstreamState = { accounts: [nextAccount] };
  const result = await getRepo().upstreams.saveState(id, nextState, { expectedState: fresh.state });
  if (!result.updated) return { kind: 'cas-lost', refreshTokenUsed: account.refreshToken };
  return { kind: 'ok' };
};

// The body carries an optional `proxy_fallback_list` override so a refresh
// fired from an unsaved edit-form uses the proxy chain the operator is
// currently editing, not the persisted one. Absent override → fall back to
// the persisted row's list. See proxy-resolution.ts for the layered policy.
//
// Refresh-race recovery: the operator-initiated refresh and the data-plane
// access-token cache both call `/v1/oauth/token` with the same RT. When the
// two interleave (operator click while a data-plane request is mid-mint),
// one of them rotates the RT and the other observes either CAS-loss or
// `invalid_grant`. We mirror the data-plane's recovery (see
// `recoverFromRefreshRace` in access-token-cache.ts): on loss, re-read the
// row; if a sibling rotated successfully, report success instead of a
// misleading "credential dead" toast.
export const claudeCodeRefreshNow = async (c: CtxWithJson<typeof claudeCodeRefreshNowBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.kind !== 'claude-code') {
    return c.json({ error: 'Claude Code upstream not found' }, 404);
  }

  // A throw from readClaudeCodeUpstreamState means the row's state column was
  // hand-edited or otherwise corrupted — the framework-level 500
  // handler stack-traces internally without surfacing the parse error to the
  // dashboard.
  const account = readClaudeCodeUpstreamState(existing.state).accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Claude Code upstream is ${account.state}; re-import to recover` }, 400);
  }
  // Setup-token credentials have no refresh counterpart — there is nothing
  // to rotate. The UI does not surface a Refresh button for setup-token
  // accounts, so an inbound request here is either a stale browser tab or a
  // direct API caller; reject with a precise message rather than silently
  // succeeding.
  if (account.tokenKind === 'setup-token') {
    return c.json({ error: 'Setup-token credentials cannot be refreshed; re-import to rotate' }, 400);
  }

  const body = c.req.valid('json');
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Bounded by `recoveryAllowed`: at most one recovery re-mint per request.
  // Mirrors the data-plane depth guard.
  let recoveryAllowed = true;
  while (true) {
    const attempt = await attemptClaudeCodeRefresh(id, fetcher);

    if (attempt.kind === 'ok') return await respondWithFreshRow(id, c);

    if (attempt.kind === 'cas-lost') {
      if (recoveryAllowed) {
        const outcome = await recoverRefreshNow(id, attempt.refreshTokenUsed);
        if (outcome === 'recovered') return await respondWithFreshRow(id, c);
        if (outcome === 'retry-mint') { recoveryAllowed = false; continue; }
      }
      // Either out of recovery budget, or the re-read shows no sibling
      // rotation — surface 409 so the operator can retry on a calmer window.
      return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
    }

    // attempt.kind === 'oauth-terminal'
    if (attempt.error.code === 'invalid_grant' && recoveryAllowed) {
      const outcome = await recoverRefreshNow(id, attempt.refreshTokenUsed);
      if (outcome === 'recovered') return await respondWithFreshRow(id, c);
      if (outcome === 'retry-mint') { recoveryAllowed = false; continue; }
      // genuine-failure: fall through to the terminal-flip path below.
    }

    // OAuth session terminated without a recoverable sibling rotation:
    // mirror the data-plane behavior — flip the row to `refresh_failed`
    // so the dashboard surfaces the red badge and the operator sees a
    // Re-import affordance instead of a stale Refresh button.
    const failedAccount: ClaudeCodeAccountCredential = {
      ...attempt.baselineAccount,
      state: 'refresh_failed',
      stateMessage: attempt.error.upstreamMessage,
      stateUpdatedAt: new Date().toISOString(),
      // Refresh failure invalidates whatever access token still sat in state;
      // even if the data-plane somehow bypassed the active-state gate, the
      // cached token wouldn't outlive the refresh failure for long.
      accessToken: null,
    };
    const failedState: ClaudeCodeUpstreamState = { accounts: [failedAccount] };
    // Best-effort: a losing CAS means a concurrent rotation already wrote
    // newer state, which by definition supersedes ours.
    await getRepo().upstreams.saveState(id, failedState, { expectedState: attempt.baselineRaw });
    // 400, not 502: the upstream IS answering — it's telling us the stored
    // refresh token is dead. That's a client-side credential problem, not
    // an upstream outage. 401 is wrong too: the dashboard's auth client
    // logs the operator out on any 401 (apps/web/src/api/client.ts), and
    // a "your claude-code credential is dead" condition must not be confused
    // with "your dashboard auth is invalid".
    return c.json({ error: `Claude Code refresh failed: ${attempt.error.upstreamMessage}. Re-import the credential to recover.` }, 400);
  }
};

// Operator-driven active quota probe — Claude Code only. Mirrors real CC's
// `fetchUtilization: GET /api/oauth/usage` call (binary string in
// @anthropic-ai/claude-code@2.1.181). Returns the upstream body verbatim
// plus the wall-clock fetched_at and persists into `usageProbeSnapshot`
// state so the dashboard's next render sees the freshest snapshot without
// re-probing. Persistence is best-effort: a CAS loss to a concurrent
// rotation is fine because the live response already returned to the
// operator regardless.
const persistUsageProbeSnapshot = async (
  upstreamId: string,
  fetchedAt: string,
  body: unknown,
  auditActor: number,
): Promise<void> => {
  const fresh = await getRepo().upstreams.getById(upstreamId);
  if (!fresh) return;
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];
  const next: ClaudeCodeUpstreamState = {
    ...state,
    accounts: state.accounts.map((a, i): ClaudeCodeAccountCredential => i === 0 ? {
      ...a,
      usageProbeSnapshot: { fetchedAt: Date.parse(fetchedAt), data: body },
    } : a),
  };
  const result = await getRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
  if (!result.updated) {
    logInfo('claude_code_admin_action', {
      upstream_id: upstreamId,
      action: 'quota_probe',
      actor: auditActor,
      outcome: 'persist_cas_lost',
      account_uuid: account.accountUuid,
    });
  }
};

export const claudeCodeProbeQuota = async (c: CtxWithJson<typeof claudeCodeProbeQuotaBody, '/:id'>) => {
  const id = c.req.param('id');
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);
  // Setup-token credentials lack the user:profile scope; /api/oauth/usage
  // still answers under inference-only scopes (sub2api hits it identically
  // for setup tokens), so we don't gate by tokenKind. The provider gate is
  // the only relevant filter.
  if (existing.kind !== 'claude-code') {
    return c.json({ error: 'Quota probe is only supported for claude-code upstreams' }, 400);
  }

  const body = c.req.valid('json');
  const actor = userFromContext(c).id;
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: body.proxy_fallback_list, upstreamId: id, currentColo: getCurrentColo(c.req.raw) });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let probe;
  try {
    const access = await ensureClaudeCodeAccessToken({
      upstreamId: id,
      repo: getRepo().upstreams,
      fetcher,
    });
    probe = await fetchClaudeCodeUsageProbe(access.entry.token, fetcher);
  } catch (err) {
    logInfo('claude_code_admin_action', {
      upstream_id: id,
      action: 'quota_probe',
      actor,
      outcome: 'error',
      error: errorMessage(err),
    });
    // A terminal credential surfaces as 503 (mirroring the data-plane wrap)
    // so the dashboard can render the same "credential dead" affordance.
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}` }, 503);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  await persistUsageProbeSnapshot(id, probe.fetched_at, probe.body, actor);
  logInfo('claude_code_admin_action', {
    upstream_id: id,
    action: 'quota_probe',
    actor,
    outcome: 'ok',
  });
  // Spread the upstream body at the top level so the response shape
  // matches what real CC's `fetchUtilization` parses (five_hour,
  // seven_day, seven_day_sonnet, seven_day_opus, optional overage
  // fields). `fetched_at` rides alongside as the gateway-stamped
  // wall-clock. The body is typed unknown by the helper because
  // Anthropic adds fields without warning — surface as Record so Hono's
  // c.json accepts it.
  return c.json({ fetched_at: probe.fetched_at, ...(probe.body as Record<string, unknown>) });
};
