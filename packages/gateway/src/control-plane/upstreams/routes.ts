import type { Context } from 'hono';

import { blueprintUpstreamRecord, upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { FullSerializedUpstreamRecord, ModelsCacheStatus, RedactedSerializedUpstreamRecord } from './types.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import { type AuthedContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { shortId } from '../../shared/short-id.ts';
import type { createUpstreamBody, updateUpstreamBody } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { nextSortOrder } from '../shared/sort-order.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import {
  normalizeModelPrefix,
  ALL_PROVIDER_KINDS,
  type ModelPrefixConfig,
  type ProxyFallbackEntry,
  type UpstreamProviderKind,
  type UpstreamRecord,
} from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import { assertClaudeCodeUpstreamRecord, readClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { type CodexQuotaSnapshotMap, assertCodexUpstreamRecord, assertCodexUpstreamState, getCodexQuota } from '@floway-dev/provider-codex';
import { parseCopilotUpstreamConfig, readCopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord } from '@floway-dev/provider-ollama';

type CodexQuotaProjection = { codex_quota?: CodexQuotaSnapshotMap | null };

type SerializedUpstreamRecord = FullSerializedUpstreamRecord | RedactedSerializedUpstreamRecord;

type UpstreamResponse = SerializedUpstreamRecord & CodexQuotaProjection;

type UpstreamWithCacheResponse = UpstreamResponse & {
  modelsCache: ModelsCacheStatus;
};

const codexQuotaForResponse = async (record: UpstreamRecord): Promise<CodexQuotaProjection> => {
  if (record.kind !== 'codex') return {};
  assertCodexUpstreamRecord(record);
  return {
    codex_quota: await getCodexQuota(record.id, record.config.accounts[0].chatgptAccountId),
  };
};

const loadKnownProxyIds = async (): Promise<ReadonlySet<string>> =>
  new Set((await getRepo().proxies.list()).map(proxy => proxy.id));

// Deleting a proxy is refused while an upstream still names it, so a dangling
// entry only arises from a raced delete or a hand-edited row. Reads drop those
// entries instead of handing the edit form a chip it cannot resolve and would
// re-submit into a write path that rejects the whole list. Dial time already
// skips an unresolvable entry and advances the chain.
const pruneDeletedProxyEntries = (
  entries: readonly ProxyFallbackEntry[],
  knownProxyIds: ReadonlySet<string>,
): ProxyFallbackEntry[] => entries.filter(entry => isDirectFallbackId(entry.id) || knownProxyIds.has(entry.id));

// Response-only projections, which serialize.ts excludes so it stays a pure
// persisted-record transform: the Codex quota because it needs provider I/O,
// the models-cache freshness because a dump must not carry the catalog. The
// optional baseSerialize override lets callers swap in upstreamRecordToFullJson
// to round-trip unredacted secrets instead of the redacted default.
const serializeForResponse = async (
  record: UpstreamRecord,
  knownProxyIds: ReadonlySet<string>,
  baseSerialize: (r: UpstreamRecord) => SerializedUpstreamRecord = upstreamRecordToJson,
): Promise<UpstreamWithCacheResponse> => {
  const codexQuota = await codexQuotaForResponse(record);
  const serialized = baseSerialize(record);
  return {
    ...serialized,
    proxy_fallback_list: pruneDeletedProxyEntries(serialized.proxy_fallback_list, knownProxyIds),
    modelsCache: {
      fetchedAt: record.modelsCache?.fetchedAt ?? null,
      lastError: record.modelsCache?.lastError ?? null,
      modelCount: storedCatalogSize(record),
    },
    ...codexQuota,
  };
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
      value: parseCopilotUpstreamConfig(
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

// Built-in direct transports are always valid entry ids; every other id must
// reference an existing proxy row. List order matters at dial time (see
// createFetcher), and persistence layers dedupe before storing.
const validateProxyFallbackList = (
  entries: readonly ProxyFallbackEntry[],
  knownProxyIds: ReadonlySet<string>,
): { ok: true } | { ok: false; error: string } => {
  for (const entry of entries) {
    if (isDirectFallbackId(entry.id) || knownProxyIds.has(entry.id)) continue;
    return { ok: false, error: `unknown proxy id in fallback list: ${entry.id}` };
  }
  return { ok: true };
};

export const listUpstreams = async (c: Context) => {
  const [items, knownProxyIds] = await Promise.all([getRepo().upstreams.list(), loadKnownProxyIds()]);
  return c.json(await Promise.all(items.map(record => serializeForResponse(record, knownProxyIds))));
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
      hue: upstream.hue,
      // The picker states a model count per upstream, and a disabled upstream
      // is absent from the live catalog the picker counts against, so it also
      // carries the size of the catalog it stored while it was on.
      cachedModelCount: storedCatalogSize(upstream),
    })));
};

// Supply every shared editor field for an unpersisted record. The empty cache
// projection avoids querying storage, while persisted-only projections remain
// exclusive to full edit responses.
export const getUpstreamBlueprint = (c: Context) => {
  const kind = c.req.query('kind');
  if (!isValidProviderKind(kind)) {
    return c.json({ error: `kind must be one of: ${ALL_PROVIDER_KINDS.join(', ')}` }, 400);
  }
  return c.json({
    ...blueprintUpstreamRecord(kind),
    modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
  });
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
  const [record, knownProxyIds] = await Promise.all([getRepo().upstreams.getById(id), loadKnownProxyIds()]);
  if (!record) return c.json({ error: 'upstream not found' }, 404);
  return c.json(await serializeForResponse(record, knownProxyIds, upstreamRecordToFullJson));
};

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

  const proxyFallbackList = normalizeProxyFallbackList(body.proxy_fallback_list ?? []);
  const knownProxyIds = await loadKnownProxyIds();
  const fallbackCheck = validateProxyFallbackList(proxyFallbackList, knownProxyIds);
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
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    proxyFallbackList,
    modelPrefix,
    hue: body.hue,
    config: body.config,
    state: stateFromBody,
    // Operator edits never carry the catalog cache; the repo leaves the
    // column to the refresh path.
    modelsCache: null,
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
  // Answer with the catalog status this warm produced, not the one the record
  // was built with — the dashboard re-seeds its draft from this body.
  const modelsCache = await warmModelsCache(record, c);
  return c.json(await serializeForResponse({ ...record, modelsCache }, knownProxyIds), 201);
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

  const knownProxyIds = await loadKnownProxyIds();
  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.sort_order !== undefined) next = { ...next, sortOrder: body.sort_order };
  if (body.flag_overrides !== undefined) next = { ...next, flagOverrides: body.flag_overrides };
  if (body.disabled_public_model_ids !== undefined) next = { ...next, disabledPublicModelIds: body.disabled_public_model_ids };
  if (body.proxy_fallback_list !== undefined) {
    const normalized = normalizeProxyFallbackList(body.proxy_fallback_list);
    const fallbackCheck = validateProxyFallbackList(normalized, knownProxyIds);
    if (!fallbackCheck.ok) return c.json({ error: fallbackCheck.error }, 400);
    next = { ...next, proxyFallbackList: normalized };
  }
  if (body.model_prefix !== undefined) {
    const result = normalizeModelPrefixField(body.model_prefix);
    if (!result.ok) return c.json({ error: result.error }, 400);
    next = { ...next, modelPrefix: result.value };
  }
  if (body.hue !== undefined) next = { ...next, hue: body.hue };
  if (body.config !== undefined) {
    const config = mergeConfigPatch(existing.kind, existing.config, body.config);
    if (!config.ok) return c.json({ error: config.error }, 400);
    next = { ...next, config: config.value };
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };

  await getRepo().upstreams.save(next);
  const modelsCache = await warmModelsCache(next, c);
  return c.json(await serializeForResponse({ ...next, modelsCache }, knownProxyIds));
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
