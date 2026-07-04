import type { Context } from 'hono';

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { blueprintUpstreamRecord, upstreamRecordToFullJson, upstreamRecordToJson, type SerializedUpstreamRecord } from './serialize.ts';
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
import type { claudeCodeOauthAuthorizeUrlBody, claudeCodeOauthExchangeBody, claudeCodeOauthRefreshBody, claudeCodeProbeBody, claudeCodeSetupTokenAuthorizeUrlBody, claudeCodeSetupTokenExchangeBody, codexOauthAuthorizeUrlBody, codexOauthExchangeBody, codexOauthRefreshBody, copilotOauthDeviceLoginPollBody, copilotQuotaBody, createUpstreamBody, listModelsBody, updateUpstreamBody } from '../schemas.ts';
import { copilotConfigField, type CopilotUpstreamConfig, isRecord } from '../shared/field-validators.ts';
import {
  getFlagCatalog,
  normalizeModelPrefix,
  ProviderModelsUnavailableError,
  ALL_PROVIDER_KINDS,
  type Fetcher,
  type ModelPrefixConfig,
  type ProviderModel,
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
  type CodexQuotaSnapshotMap,
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
import { clearInProcessCopilotTokenCache, exchangeCopilotToken, githubHeaders, readCopilotUpstreamState, type CopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, createOllamaProvider } from '@floway-dev/provider-ollama';

// Serialize for the HTTP response, attaching the live codex_quota snapshot map
// when the row is a Codex upstream and the SWR models-cache freshness for
// every row. Keeps serialize.ts free of provider I/O and a global repo handle,
// while ensuring every response shape carries the panels the dashboard
// expects.
const serializeForResponse = async (record: UpstreamRecord): Promise<SerializedUpstreamRecord> => {
  let codexQuotaPromise: Promise<CodexQuotaSnapshotMap | null> | null = null;
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

const isValidProviderKind = (value: unknown): value is UpstreamProviderKind =>
  typeof value === 'string' && (ALL_PROVIDER_KINDS as readonly string[]).includes(value);

// Serve a shape-complete blank SerializedUpstreamRecord for the requested
// kind. The create page's loader calls this so it can render the same
// UpstreamEditPage component edit uses, treating a fresh upstream as an
// edit of an unpersisted record. The record is never written; the client's
// draft state is the sole source of truth until Save.
export const getUpstreamBlueprint = (c: Context): Response => {
  const kind = c.req.query('kind');
  if (!isValidProviderKind(kind)) {
    return c.json({ error: `kind must be one of: ${ALL_PROVIDER_KINDS.join(', ')}` }, 400);
  }
  return c.json(upstreamRecordToFullJson(blueprintUpstreamRecord(kind)));
};

// Single-record read for the edit page. Returns the FULL record — no
// secret redaction — because every editor-scoped action posts the record
// back to a helper endpoint that needs the same credentials the data plane
// uses (refresh tokens, api keys, etc.). The list endpoint continues to
// serve the redacted projection for surfaces that don't need secrets.
export const getUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const record = await getRepo().upstreams.getById(id);
  if (!record) return c.json({ error: 'upstream not found' }, 404);
  return c.json(upstreamRecordToFullJson(record));
};

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

  const proxyFallbackList = normalizeProxyFallbackList(body.proxy_fallback_list ?? []);
  const fallbackCheck = await validateProxyFallbackList(proxyFallbackList);
  if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);

  const modelPrefixResult = normalizeModelPrefixField(body.model_prefix);
  if (!modelPrefixResult.ok) return c.json({ error: modelPrefixResult.error }, 400);
  const modelPrefix = modelPrefixResult.value;

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  // Copilot / Codex / Claude Code carry OAuth-derived server-owned fields
  // (config.githubToken + config.user for Copilot; config.accounts +
  // state.accounts for the multi-account providers) that the create page
  // populated in draft via the corresponding OAuth-exchange helper before
  // Save. The per-kind assertXxxUpstreamRecord below narrows those opaque
  // payloads into their typed shape and rejects a POST that skipped the
  // credential step.
  const stateFromBody = body.kind === 'copilot' || body.kind === 'codex' || body.kind === 'claude-code' ? body.state ?? null : null;
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
    state: stateFromBody,
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

export const copilotOauthDeviceLoginStart = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

// Unified device-login poll under the record-body action contract. The
// GitHub device flow is inherently stateless; this handler exchanges the
// device_code for a GitHub PAT + user info + Copilot access token, and
// returns them as a patch to merge into the caller's draft record. When
// the caller supplies a persisted `record.id`, the same patch is
// simultaneously applied to the stored record so the live data plane
// picks up the fresh credential immediately.
export const copilotOauthDeviceLoginPoll = async (c: CtxWithJson<typeof copilotOauthDeviceLoginPollBody>) => {
  try {
    const { record, deviceCode } = c.req.valid('json');
    const fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, currentColo: getCurrentColo(c.req.raw) });

    const data = await pollGitHubDeviceFlow(deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' as const });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down' as const, interval: data.interval });
    if (data.error) return c.json({ status: 'error' as const, error: data.error_description ?? data.error }, 400);
    if (!data.access_token) return c.json({ status: 'error' as const, error: 'Unknown response' }, 500);

    const user = await fetchGitHubUser(data.access_token, fetcher);
    // Validates the PAT + seeds a fresh Copilot access token so the data
    // plane and dashboard `endpoints.api` calls work immediately without
    // a follow-up exchange round trip.
    const tokenEntry = await exchangeCopilotToken(data.access_token, fetcher);

    const configPatch: CopilotUpstreamConfig = { githubToken: data.access_token, user };
    const statePatch = { copilotToken: tokenEntry };

    // Edit state (id present): targeted-patch the stored record so any
    // in-flight data-plane traffic on this upstream sees the new token
    // right away. Only credential fields are touched — the caller's
    // draft-only form edits (name, flags, etc.) never reach the DB from
    // this handler; save endpoints are the sole route for those.
    if (record.id !== '') {
      const dbRecord = await getRepo().upstreams.getById(record.id);
      if (!dbRecord) return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
      if (dbRecord.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
      const prevState = readCopilotUpstreamState(dbRecord.state);
      const nextState: CopilotUpstreamState = { ...prevState, ...statePatch };
      const next: UpstreamRecord = { ...dbRecord, config: configPatch, state: nextState, updatedAt: new Date().toISOString() };
      await getRepo().upstreams.save(next);
      clearInProcessCopilotTokenCache();
      await warmModelsCache(next, c);
    }

    return c.json({
      status: 'complete' as const,
      user,
      patch: {
        config: configPatch,
        state: statePatch,
      },
    });
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ status: 'error' as const, error: msg }, 502);
  }
};

interface CopilotQuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface CopilotUsageResponse {
  access_type_sku: string;
  analytics_tracking_id: string;
  assigned_date: string;
  can_signup_for_limited: boolean;
  chat_enabled: boolean;
  copilot_plan: string;
  organization_login_list: unknown[];
  organization_list: unknown[];
  quota_reset_date: string;
  quota_snapshots: {
    chat: CopilotQuotaDetail;
    completions: CopilotQuotaDetail;
    premium_interactions: CopilotQuotaDetail;
  };
}

// Look up GitHub Copilot quota for the draft's github token. Pure query —
// no DB touch, no patch — because the response is a live snapshot that
// the dashboard renders in place; if the operator wants it retained they
// would need a Copilot-side persistence field, which today doesn't exist.
// Works uniformly in create and edit state (draft.config.githubToken is
// the sole input).
export const copilotQuota = async (c: CtxWithJson<typeof copilotQuotaBody>) => {
  try {
    const { record } = c.req.valid('json');
    if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
    const config = isRecord(record.config) ? record.config : null;
    const githubToken = config && typeof config.githubToken === 'string' ? config.githubToken : '';
    if (!githubToken) return c.json({ error: 'Copilot upstream has no GitHub token' }, 400);

    const fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, currentColo: getCurrentColo(c.req.raw) });
    const resp = await fetcher('https://api.github.com/copilot_internal/user', { headers: githubHeaders(githubToken) });

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, status as 400 | 404 | 500 | 502);
    }

    const data = (await resp.json()) as CopilotUsageResponse;
    return c.json(data);
  } catch (e: unknown) {
    console.error('Failed to fetch Copilot quota:', e);
    return c.json({ error: 'Failed to fetch Copilot quota from GitHub' }, 502);
  }
};

// Codex OAuth under the unified record-body contract. Create and edit
// share one endpoint each: the caller posts the draft record; when
// `record.id !== ''` the produced patch is targeted-persisted, otherwise
// it is only returned for the front-end to merge into its draft.
export const codexOauthAuthorizeUrl = async (c: CtxWithJson<typeof codexOauthAuthorizeUrlBody>) => {
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

export const codexOauthExchange = async (c: CtxWithJson<typeof codexOauthExchangeBody>) => {
  const body = c.req.valid('json');
  const { record } = body;
  if (record.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let ingestion: { config: CodexUpstreamConfig; state: CodexUpstreamState };
  try {
    if (body.auth_json !== undefined) {
      ingestion = await importCodexFromAuthJson(body.auth_json);
    } else {
      const cb = body.callback!;
      ingestion = await importCodexFromCallback({ code: cb.code, codeVerifier: cb.verifier, fetcher });
    }
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Edit state: overwrite the credential slice of the stored record.
  // Single-account convention — exchange REPLACES accounts[0], no append.
  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({
    patch: {
      config: ingestion.config,
      state: ingestion.state,
    },
  });
};

export const codexOauthRefresh = async (c: CtxWithJson<typeof codexOauthRefreshBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'codex') return c.json({ error: 'Upstream is not a Codex upstream' }, 400);
  // Even in create state the caller must have completed an OAuth exchange
  // first — draft.state.accounts[0].refresh_token is the sole input the
  // refresh helper needs. In edit state the same field mirrors DB state.
  assertCodexUpstreamState(record.state);
  const account = record.state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-run OAuth exchange to recover` }, 400);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const tokens = await refreshCodexAccessToken(account.refresh_token, fetcher);
    const now = new Date();
    const nextAccount = {
      ...account,
      refresh_token: tokens.refresh_token,
      accessToken: {
        token: tokens.access_token,
        expiresAt: now.getTime() + tokens.expires_in * 1000,
        refreshedAt: now.toISOString(),
      },
    };
    const nextState: CodexUpstreamState = { accounts: [nextAccount] };

    if (record.id !== '') {
      // CAS keyed on the caller's just-read state so a concurrent data-plane
      // refresh that already rotated the row surfaces 409 instead of a
      // silent overwrite.
      const dbRecord = await getRepo().upstreams.getById(record.id);
      if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
      const result = await getRepo().upstreams.saveState(record.id, nextState, { expectedState: dbRecord.state });
      if (!result.updated) {
        return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
      }
    }

    return c.json({ patch: { state: nextState } });
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      const failedAccount = {
        ...account,
        state: 'refresh_failed' as const,
        state_message: err.upstreamMessage,
        state_updated_at: new Date().toISOString(),
        accessToken: null,
      };
      const failedState: CodexUpstreamState = { accounts: [failedAccount] };
      if (record.id !== '') {
        // Best-effort: a losing CAS means a concurrent rotation already wrote
        // newer state, which by definition supersedes ours.
        const dbRecord = await getRepo().upstreams.getById(record.id);
        if (dbRecord) await getRepo().upstreams.saveState(record.id, failedState, { expectedState: dbRecord.state });
      }
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }
};

// Claude Code OAuth + setup-token + probe endpoints under the unified
// record-body contract. Same authorize/token/probe plumbing as the
// legacy claudeCode* handlers, wrapped so create and edit share one
// endpoint each: the caller posts the draft record; when
// `record.id !== ''` the produced patch is targeted-persisted, otherwise
// only returned for the front-end to merge into its draft.

export const claudeCodeOauthAuthorizeUrl = async (c: CtxWithJson<typeof claudeCodeOauthAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge, kind: 'oauth' });
  return c.json({ authorize_url });
};

export const claudeCodeSetupTokenAuthorizeUrl = async (c: CtxWithJson<typeof claudeCodeSetupTokenAuthorizeUrlBody>) => {
  const { challenge, state } = c.req.valid('json');
  const authorize_url = buildClaudeCodeAuthorizeUrl({ state, codeChallenge: challenge, kind: 'setup-token' });
  return c.json({ authorize_url });
};

export const claudeCodeOauthExchange = async (c: CtxWithJson<typeof claudeCodeOauthExchangeBody>) => {
  const body = c.req.valid('json');
  const { record } = body;
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let ingestion: { config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState };
  try {
    if (body.credentials_json !== undefined) {
      ingestion = await importClaudeCodeFromCredentialsJson(body.credentials_json, fetcher);
    } else {
      const cb = body.callback!;
      ingestion = await importClaudeCodeFromCallback({ code: cb.code, pkceVerifier: cb.verifier, state: cb.state, fetcher });
    }
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({ patch: { config: ingestion.config, state: ingestion.state } });
};

export const claudeCodeSetupTokenExchange = async (c: CtxWithJson<typeof claudeCodeSetupTokenExchangeBody>) => {
  const { record, callback } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  let ingestion: { config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState };
  try {
    ingestion = await importClaudeCodeFromSetupTokenCallback({
      code: callback.code,
      pkceVerifier: callback.verifier,
      state: callback.state,
      fetcher,
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);
    const next: UpstreamRecord = {
      ...dbRecord,
      config: ingestion.config,
      state: ingestion.state,
      updatedAt: new Date().toISOString(),
    };
    await getRepo().upstreams.save(next);
    await warmModelsCache(next, c);
  }

  return c.json({ patch: { config: ingestion.config, state: ingestion.state } });
};

export const claudeCodeOauthRefresh = async (c: CtxWithJson<typeof claudeCodeOauthRefreshBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Upstream is not a Claude Code upstream' }, 400);

  // record.state is unknown from the envelope; a corrupt shape throws at
  // the framework 500 boundary. The single-account convention means
  // refresh always targets accounts[0].
  const parsedState = readClaudeCodeUpstreamState(record.state);
  const account = parsedState.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Claude Code upstream is ${account.state}; re-run OAuth exchange to recover` }, 400);
  }
  if (account.tokenKind === 'setup-token') {
    return c.json({ error: 'Setup-token credentials cannot be refreshed; re-run setup-token exchange to rotate' }, 400);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    const tokens = await refreshClaudeCodeAccessToken(account.refreshToken, fetcher);
    const now = new Date();
    const nextAccount: ClaudeCodeAccountCredential = {
      ...account,
      refreshToken: tokens.refresh_token ?? account.refreshToken,
      accessToken: {
        token: tokens.access_token,
        expiresAt: now.getTime() + tokens.expires_in * 1000,
        refreshedAt: now.toISOString(),
      },
    };
    const nextState: ClaudeCodeUpstreamState = { ...parsedState, accounts: [nextAccount] };

    if (record.id !== '') {
      const dbRecord = await getRepo().upstreams.getById(record.id);
      if (!dbRecord) return c.json({ error: 'Upstream not found' }, 404);
      const result = await getRepo().upstreams.saveState(record.id, nextState, { expectedState: dbRecord.state });
      if (!result.updated) {
        return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
      }
    }

    return c.json({ patch: { state: nextState } });
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      const failedAccount: ClaudeCodeAccountCredential = {
        ...account,
        state: 'refresh_failed',
        stateMessage: err.upstreamMessage,
        stateUpdatedAt: new Date().toISOString(),
        accessToken: null,
      };
      const failedState: ClaudeCodeUpstreamState = { ...parsedState, accounts: [failedAccount] };
      if (record.id !== '') {
        const dbRecord = await getRepo().upstreams.getById(record.id);
        if (dbRecord) await getRepo().upstreams.saveState(record.id, failedState, { expectedState: dbRecord.state });
      }
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }
};

export const claudeCodeProbe = async (c: CtxWithJson<typeof claudeCodeProbeBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'claude-code') return c.json({ error: 'Quota probe is only supported for claude-code upstreams' }, 400);
  const actor = userFromContext(c).id;

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Resolving a fresh access token demands DB access (the token cache
  // and CAS-guarded refresh live there), so probe on a create-state
  // record requires that the caller has ensured a fresh access_token
  // sits in draft.state.accounts[0].accessToken from the OAuth
  // exchange step. In edit state, we can call the standard cache
  // helper that reads / refreshes from DB.
  let accessToken: string;
  try {
    if (record.id !== '') {
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getRepo().upstreams,
        fetcher,
      });
      accessToken = access.entry.token;
    } else {
      const parsedState = readClaudeCodeUpstreamState(record.state);
      const account = parsedState.accounts[0];
      if (!account.accessToken?.token) {
        return c.json({ error: 'Draft account has no fresh access token; run OAuth refresh first' }, 400);
      }
      accessToken = account.accessToken.token;
    }
  } catch (err) {
    logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'error', error: errorMessage(err) });
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}` }, 503);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  let probe;
  try {
    probe = await fetchClaudeCodeUsageProbe(accessToken, fetcher);
  } catch (err) {
    logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'error', error: errorMessage(err) });
    return c.json({ error: errorMessage(err) }, 502);
  }

  const snapshotPatch = {
    usageProbeSnapshot: { fetchedAt: Date.parse(probe.fetched_at), data: probe.body },
  };

  if (record.id !== '') {
    // Best-effort CAS persist — same rationale as the legacy handler.
    const fresh = await getRepo().upstreams.getById(record.id);
    if (fresh) {
      const parsed = readClaudeCodeUpstreamState(fresh.state);
      const next: ClaudeCodeUpstreamState = {
        ...parsed,
        accounts: parsed.accounts.map((a, i): ClaudeCodeAccountCredential => i === 0 ? { ...a, ...snapshotPatch } : a),
      };
      await getRepo().upstreams.saveState(record.id, next, { expectedState: fresh.state });
    }
  }

  logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'ok' });
  return c.json({
    fetched_at: probe.fetched_at,
    body: probe.body,
    patch: { state: { accounts: [snapshotPatch] } },
  });
};

// Unified model catalog fetch replacing both fetch-models (draft
// preview) and :id/models (saved-record refresh). Always live-fetches
// on the control plane; when record.id !== '' the request also
// warms/refreshes the SWR cache via `fetchUpstreamModelsCached` so a
// subsequent data-plane call picks up the fresh catalog. Custom's
// response stays the raw upstream row shape (dashboard translates
// through the draft's endpoints); every other kind returns
// UpstreamModelConfig-shaped rows.
const reshapeModelForDashboard = (model: ProviderModel): Record<string, unknown> => ({
  upstreamModelId: providerDataUpstreamModelId(model.providerData) ?? model.id,
  publicModelId: model.id,
  kind: model.kind,
  endpoints: model.endpoints,
  ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
  ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
  ...(model.cost ? { cost: model.cost } : {}),
  ...(model.chat ? { chat: model.chat } : {}),
});

export const listModels = async (c: CtxWithJson<typeof listModelsBody>) => {
  const { record } = c.req.valid('json');
  if (!(ALL_PROVIDER_KINDS as readonly string[]).includes(record.kind)) {
    return c.json({ error: { message: `Invalid kind: ${record.kind}`, type: 'invalid_request_error' } }, 400);
  }
  const kind = record.kind as UpstreamProviderKind;

  const scheduler = backgroundSchedulerFromContext(c);
  const now = new Date().toISOString();
  const synthRecord: UpstreamRecord = {
    id: record.id || 'draft',
    kind,
    name: 'draft',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: (record.proxy_fallback_list ?? []) as ProxyFallbackEntry[],
    modelPrefix: null,
    config: record.config,
    state: record.state,
  };

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      currentColo: getCurrentColo(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    if (kind === 'custom') {
      const assertedConfig = assertCustomUpstreamRecord(synthRecord).config;
      const result = await fetchCustomModels(assertedConfig, fetcher);
      return c.json(result);
    }
    if (kind === 'ollama') {
      assertOllamaUpstreamRecord(synthRecord);
      const instance = createOllamaProvider(synthRecord);
      const models = await instance.instance.getProvidedModels(fetcher);
      return c.json({ data: models.map(reshapeModelForDashboard) });
    }
    // Copilot / codex / claude-code / azure — use the provider factory.
    // Force through the SWR cache when the record is persisted so the
    // side-effect refresh keeps the data-plane cache in step; otherwise
    // live-fetch without any caching.
    const instance = await createProviderInstance(synthRecord);
    const models = record.id !== ''
      ? await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: true })
      : await instance.instance.getProvidedModels(fetcher);
    return c.json({ data: models.map(reshapeModelForDashboard) });
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
