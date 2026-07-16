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
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { shortId } from '../../shared/short-id.ts';
import { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow, type GitHubUser } from '../auth/github-device-flow.ts';
import type { claudeCodeOauthAuthorizeUrlBody, claudeCodeOauthExchangeBody, claudeCodeOauthRefreshBody, claudeCodeProbeBody, claudeCodeSetupTokenAuthorizeUrlBody, claudeCodeSetupTokenExchangeBody, codexOauthAuthorizeUrlBody, codexOauthExchangeBody, codexOauthRefreshBody, copilotOauthDeviceLoginPollBody, copilotQuotaBody, createUpstreamBody, listModelsBody, updateUpstreamBody } from '../schemas.ts';
import { copilotConfigField, type CopilotUpstreamConfig, isRecord } from '../shared/field-validators.ts';
import {
  normalizeModelPrefix,
  OPTIONAL_FLAGS,
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
  ensureCodexAccessToken,
  getCodexQuota,
  importCodexFromAuthJson,
  importCodexFromCallback,
  mintCodexAccessToken,
} from '@floway-dev/provider-codex';
import { clearInProcessCopilotTokenCache, emptyCopilotUpstreamState, exchangeCopilotToken, githubHeaders, readCopilotUpstreamState, type CopilotTokenEntry, type CopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, createOllamaProvider } from '@floway-dev/provider-ollama';

type CodexQuotaProjection = { codex_quota?: CodexQuotaSnapshotMap | null };

type UpstreamResponse = SerializedUpstreamRecord & CodexQuotaProjection;

type UpstreamWithCacheResponse = UpstreamResponse & {
  modelsCache: {
    fetchedAt: number | null;
    lastError: { message: string; at: number } | null;
  };
};

const codexQuotaForResponse = async (record: UpstreamRecord): Promise<CodexQuotaProjection> => {
  if (record.kind !== 'codex') return {};
  assertCodexUpstreamRecord(record);
  return {
    codex_quota: await getCodexQuota(record.id, record.config.accounts[0].chatgptAccountId),
  };
};

// These projections need repository/provider I/O, which serialize.ts excludes
// so it stays a pure persisted-record transform. The optional baseSerialize
// override lets callers swap in upstreamRecordToFullJson to round-trip
// unredacted secrets instead of the redacted default.
const serializeForResponse = async (
  record: UpstreamRecord,
  baseSerialize: (r: UpstreamRecord) => SerializedUpstreamRecord = upstreamRecordToJson,
): Promise<UpstreamWithCacheResponse> => {
  const [cacheRow, codexQuota] = await Promise.all([
    getRepo().modelsCache.get(record.id),
    codexQuotaForResponse(record),
  ]);
  return {
    ...baseSerialize(record),
    modelsCache: {
      fetchedAt: cacheRow?.fetchedAt ?? null,
      lastError: cacheRow?.lastError ?? null,
    },
    ...codexQuota,
  };
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

// Synchronously populate the SWR models cache for a freshly-saved upstream
// so the dashboard's next navigation lands on a populated row. Upstream
// fetch failures are persisted to the row's `lastError` by runFetch and
// surfaced by the dashboard, so we discard the throw here. Provider
// instance and fetcher construction errors are not swallowed; those signal
// genuine misconfiguration that the operator must see.
const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<void> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const instance = createProviderInstance(record);
  const fetcher = (await createPerRequestFetcher(getRuntimeLocation(c.req.raw)))(record.id);
  try {
    await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: true });
  } catch (e) {
    // runFetch persists upstream failures to the row's `lastError`; anything
    // reaching here is a Floway-side fault (lastError write itself failed,
    // scheduler blew up, sqlite ran out of space, etc.). Log so the failure
    // is observable — the dashboard would otherwise silently show a stale
    // cache with no explanation.
    logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(e) });
  }
};

// Built-in direct transports are always valid entry ids; every other id must
// reference an existing proxy row. List order matters at dial time (see
// createFetcher), and persistence layers dedupe before storing.
const validateProxyFallbackList = async (entries: readonly ProxyFallbackEntry[]): Promise<{ ok: true } | { ok: false; error: string }> => {
  const ids = entries.map(e => e.id).filter(id => !isDirectFallbackId(id));
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
  return c.json(await Promise.all(items.map(record => serializeForResponse(record))));
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
      color: upstream.color,
    })));
};

export const listOptionalFlags = (c: Context) => c.json(OPTIONAL_FLAGS);

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
// uses (refresh tokens, api keys, etc.). Codex quota and modelsCache are
// response-only projections, so they are attached here alongside the
// unredacted config/state — the edit page relies on `modelsCache` to
// render the "last fetched / last error" panel on mount.
export const getUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const record = await getRepo().upstreams.getById(id);
  if (!record) return c.json({ error: 'upstream not found' }, 404);
  return c.json(await serializeForResponse(record, upstreamRecordToFullJson));
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
    id: shortId('up'),
    kind: body.kind,
    name: body.name,
    enabled: body.enabled ?? true,
    sortOrder: body.sort_order ?? existing.reduce((acc, u) => Math.max(acc, u.sortOrder), -1) + 1,
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    proxyFallbackList,
    modelPrefix,
    color: body.color ?? null,
    config: body.config,
    state: stateFromBody,
  };

  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  // Server-owned state (copilotToken, OAuth account slots) originates from
  // this repo's own exchange endpoints, so a legitimate caller's body.state
  // is already well-shaped. We still assert here because POST /api/upstreams
  // accepts state on create — a caller who bypasses the exchange helpers
  // could otherwise persist garbage that only surfaces on the first
  // data-plane call. Copilot's reader accepts null as the empty blueprint
  // shape; codex / claude-code assert against null too — their blueprints
  // carry `{accounts: []}`, so an incoming null is a malformed request.
  try {
    if (upstream.kind === 'copilot') readCopilotUpstreamState(stateFromBody);
    else if (upstream.kind === 'codex') assertCodexUpstreamState(stateFromBody);
    else if (upstream.kind === 'claude-code') readClaudeCodeUpstreamState(stateFromBody);
  } catch (err) {
    return c.json({ error: `Invalid state for ${upstream.kind}: ${errorMessage(err)}` }, 400);
  }

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

  // OAuth-managed config slices (Copilot githubToken/user, Codex/Claude
  // Code accounts[]) are owned by the per-provider action endpoints, not
  // by generic PATCH. Metadata (name, enabled, sort_order, flag overrides,
  // disabled model ids) still flows through here.
  if (body.config !== undefined && (existing.kind === 'copilot' || existing.kind === 'codex' || existing.kind === 'claude-code')) {
    const endpoint = existing.kind === 'copilot'
      ? '/api/upstreams/copilot/oauth/device-login/poll'
      : `/api/upstreams/${existing.kind}/oauth/exchange`;
    return c.json({ error: `Use POST ${endpoint} to update ${existing.kind} credentials` }, 400);
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
  if (body.color !== undefined) next = { ...next, color: body.color };
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
  const { record, deviceCode } = c.req.valid('json');

  // Config-validation errors (e.g. unknown proxy id in the override) surface
  // as 400 — they belong to the caller, not to the upstream.
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (err) {
    return c.json({ status: 'error' as const, error: errorMessage(err) }, 400);
  }

  // Upstream-facing calls (GitHub device poll + user lookup + Copilot token
  // exchange) can legitimately 502 the caller when GitHub / Copilot is
  // unhealthy. DB ops below run OUTSIDE this catch so that a repo `.save()`
  // or scheduler failure surfaces as a 500 with a stack, not as a
  // misleading "upstream error" 502.
  type UpstreamCred = { user: GitHubUser; tokenEntry: CopilotTokenEntry; accessToken: string };
  let cred: UpstreamCred;
  try {
    const data = await pollGitHubDeviceFlow(deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' as const });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down' as const, interval: data.interval });
    if (data.error) return c.json({ status: 'error' as const, error: data.error_description ?? data.error }, 400);
    if (!data.access_token) return c.json({ status: 'error' as const, error: 'Unknown response' }, 500);

    // Validates the PAT + seeds a fresh Copilot access token so the data
    // plane and dashboard `endpoints.api` calls work immediately without
    // a follow-up exchange round trip.
    const user = await fetchGitHubUser(data.access_token, fetcher);
    const tokenEntry = await exchangeCopilotToken(data.access_token, fetcher);
    cred = { user, tokenEntry, accessToken: data.access_token };
  } catch (e: unknown) {
    return c.json({ status: 'error' as const, error: errorMessage(e) }, 502);
  }

  const configPatch: CopilotUpstreamConfig = { githubToken: cred.accessToken, user: cred.user };

  // Return the fully-merged state slot instead of a partial `{ copilotToken }`
  // patch. Frontend `applyPatch` does whole-slot replacement on state, so a
  // partial slot would clobber any sibling field (e.g. draft.state.knownModels
  // hydrated by an earlier fetch). Edit state seeds the merge from the stored
  // record; create state seeds from an empty slot so the reply is uniformly a
  // full slot regardless of caller path.
  let nextState: CopilotUpstreamState;
  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
    const prevState = readCopilotUpstreamState(dbRecord.state);
    nextState = { ...prevState, copilotToken: cred.tokenEntry };
    const next: UpstreamRecord = { ...dbRecord, config: configPatch, state: nextState, updatedAt: new Date().toISOString() };
    await getRepo().upstreams.save(next);
    clearInProcessCopilotTokenCache();
    await warmModelsCache(next, c);
  } else {
    nextState = { ...emptyCopilotUpstreamState(), copilotToken: cred.tokenEntry };
  }

  return c.json({
    status: 'complete' as const,
    user: cred.user,
    patch: {
      config: configPatch,
      state: nextState,
    },
  });
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
// the dashboard renders in place. Works uniformly in create and edit
// state (draft.config.githubToken is the sole input).
export const copilotQuota = async (c: CtxWithJson<typeof copilotQuotaBody>) => {
  try {
    const { record } = c.req.valid('json');
    if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
    const config = isRecord(record.config) ? record.config : null;
    const githubToken = config && typeof config.githubToken === 'string' ? config.githubToken : '';
    if (!githubToken) return c.json({ error: 'Copilot upstream has no GitHub token' }, 400);

    const fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
    const resp = await fetcher('https://api.github.com/copilot_internal/user', { headers: githubHeaders(githubToken) });

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, status as 400 | 404 | 500 | 502);
    }

    const data = (await resp.json()) as CopilotUsageResponse;
    return c.json(data);
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 502);
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
      runtimeLocation: getRuntimeLocation(c.req.raw),
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
  // Refresh is a stateful action on a persisted row — it delegates to
  // `ensureCodexAccessToken` which reads state from DB, mints, and
  // CAS-writes back with sibling-rotation recovery. Create-state refresh
  // has no target: the just-completed OAuth exchange handed the client a
  // brand-new refresh_token that has no reason to rotate yet, and the
  // front-end does not surface the button until Save lands the row.
  if (record.id === '') return c.json({ error: 'refresh requires a persisted upstream' }, 400);
  assertCodexUpstreamState(record.state);
  const account = record.state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-run OAuth exchange to recover` }, 400);
  }

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Persist callback shape matches `createCodexProvider` — a rotated
  // refresh_token CAS-writes back into the account slot with the just-read
  // state as the expected value. A losing CAS is not an error here: the
  // sibling that won the race already persisted a newer refresh_token, and
  // `ensureCodexAccessToken`'s `recoverFromRefreshRace` picks up the
  // sibling's fresh access token when our mint gets `invalid_grant`.
  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const fresh = await getRepo().upstreams.getById(record.id);
    if (!fresh) return;
    assertCodexUpstreamState(fresh.state);
    const next: CodexUpstreamState = {
      accounts: fresh.state.accounts.map(a => a.chatgptAccountId === account.chatgptAccountId
        ? { ...a, refresh_token: newRefreshToken, state_updated_at: new Date().toISOString() }
        : a),
    };
    await getRepo().upstreams.saveState(record.id, next, { expectedState: fresh.state });
  };

  try {
    await ensureCodexAccessToken(record.id, account.chatgptAccountId,
      refreshToken => mintCodexAccessToken(refreshToken, fetcher, persistRefreshTokenRotation),
      true);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      // Terminal flip mirrors `createCodexProvider.persistTerminalState`:
      // clear the cached access token, mark the account refresh_failed so
      // the dashboard renders the red badge and prompts a re-import.
      // Best-effort — a losing CAS means a concurrent rotation already
      // wrote newer state that supersedes ours.
      const fresh = await getRepo().upstreams.getById(record.id);
      if (fresh) {
        assertCodexUpstreamState(fresh.state);
        const next: CodexUpstreamState = {
          accounts: fresh.state.accounts.map(a => a.chatgptAccountId === account.chatgptAccountId
            ? { ...a, state: 'refresh_failed' as const, state_message: err.upstreamMessage, state_updated_at: new Date().toISOString(), accessToken: null }
            : a),
        };
        await getRepo().upstreams.saveState(record.id, next, { expectedState: fresh.state });
      }
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
};

// Claude Code OAuth + setup-token + probe endpoints under the unified
// record-body contract. Create and edit share one endpoint each: the
// caller posts the draft record; when `record.id !== ''` the produced
// patch is targeted-persisted, otherwise only returned for the
// front-end to merge into its draft.

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
      runtimeLocation: getRuntimeLocation(c.req.raw),
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
      runtimeLocation: getRuntimeLocation(c.req.raw),
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
  // Refresh delegates to the data plane's `ensureClaudeCodeAccessToken`
  // with `force: true` so operator clicks and data-plane requests share
  // the same rotation + sibling-race recovery path (no duplicated CAS
  // logic, no divergence). Create-state refresh has no target — the
  // just-completed OAuth exchange handed the client a brand-new
  // refresh_token that has no reason to rotate yet.
  if (record.id === '') return c.json({ error: 'refresh requires a persisted upstream' }, 400);

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
      upstreamId: record.id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    // `ensureClaudeCodeAccessToken` handles the whole flow: read state,
    // CAS-write the rotated refresh_token alongside the fresh access
    // token, and flip the row to refresh_failed on a terminal OAuth
    // error. All this handler contributes is the HTTP framing.
    await ensureClaudeCodeAccessToken({ upstreamId: record.id, repo: getRepo().upstreams, fetcher, force: true });
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return c.json({ error: `Claude Code refresh failed: ${err.upstreamMessage}. Re-run OAuth exchange to recover.` }, 400);
    }
    return c.json({ error: errorMessage(err) }, 502);
  }

  const updated = await getRepo().upstreams.getById(record.id);
  if (!updated) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ patch: { state: updated.state } });
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
      runtimeLocation: getRuntimeLocation(c.req.raw),
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
  const mergeSnapshotInto = (state: ClaudeCodeUpstreamState): ClaudeCodeUpstreamState => ({
    ...state,
    accounts: state.accounts.map((a, i): ClaudeCodeAccountCredential => i === 0 ? { ...a, ...snapshotPatch } : a),
  });

  // Merge the freshly-fetched snapshot into the caller's draft state so the
  // response carries a whole state slot the caller can hand to its uniform
  // patch merger — the wire contract stays symmetric with refresh/exchange
  // instead of asking the client to hand-merge into accounts[0].
  const merged = mergeSnapshotInto(readClaudeCodeUpstreamState(record.state));

  if (record.id !== '') {
    // Best-effort CAS persist against the currently-stored state — a losing
    // race means a concurrent rotation wrote newer state that supersedes
    // ours, which is fine (the snapshot rides on top of that new state on
    // the next probe).
    const fresh = await getRepo().upstreams.getById(record.id);
    if (fresh) {
      const freshMerged = mergeSnapshotInto(readClaudeCodeUpstreamState(fresh.state));
      await getRepo().upstreams.saveState(record.id, freshMerged, { expectedState: fresh.state });
    }
  }

  logInfo('claude_code_admin_action', { upstream_id: record.id, action: 'quota_probe', actor, outcome: 'ok' });
  return c.json({
    fetched_at: probe.fetched_at,
    body: probe.body,
    patch: { state: merged },
  });
};

// `upstreamModelId` is the wire-side identifier the provider will send when
// a caller invokes the public `model.id` — claude-code exposes
// `claude-sonnet-4-5` publicly while sending `claude-sonnet-4-5-20250929`
// on the wire, and other providers may distinguish similarly through their
// opaque `providerData` blob.
const reshapeModelForDashboard = (model: ProviderModel): Record<string, unknown> => {
  const providerData = typeof model.providerData === 'object' && model.providerData !== null ? model.providerData as { upstreamModelId?: unknown } : null;
  const wireId = typeof providerData?.upstreamModelId === 'string' && providerData.upstreamModelId.length > 0 ? providerData.upstreamModelId : model.id;
  return {
    upstreamModelId: wireId,
    publicModelId: model.id,
    kind: model.kind,
    endpoints: model.endpoints,
    ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
    ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
    ...(model.chat ? { chat: model.chat } : {}),
    ...(model.flagOverrides ? { flagOverrides: model.flagOverrides } : {}),
  };
};

// Unified model catalog fetch for both draft preview and saved-record
// refresh. Always live-fetches on the control plane; when
// record.id !== '' the request also warms/refreshes the SWR cache via
// `fetchUpstreamModelsCached` so a subsequent data-plane call picks up
// the fresh catalog. Custom's response stays the raw upstream row shape
// (dashboard translates through the draft's endpoints); every other
// kind returns UpstreamModelConfig-shaped rows.
export const listModels = async (c: CtxWithJson<typeof listModelsBody>) => {
  const { record } = c.req.valid('json');
  if (!isValidProviderKind(record.kind)) {
    return c.json({ error: { message: `Invalid kind: ${record.kind}`, type: 'invalid_request_error' } }, 400);
  }
  const kind = record.kind;

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
    color: null,
    config: record.config,
    state: record.state,
  };

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
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
    const instance = createProviderInstance(synthRecord);
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
