import type { Context } from 'hono';

import { cachedModelsForDashboard, modelsCacheStatus } from './models-cache-projection.ts';
import { blueprintUpstreamRecord, upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { FullSerializedUpstreamRecord, ModelsCacheStatus, RedactedSerializedUpstreamRecord } from './types.ts';
import { checkMany } from '../../access-control/check.ts';
import { type UpstreamAccess, resolveUpstreamAccesses, resolveUpstreamEditLevel } from '../../access-control/upstream-edit.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import { enumerateAddressableModelIds } from '../../data-plane/shared/listing/addressable.ts';
import { createModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { type AuthedContext, effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { shortId } from '../../shared/short-id.ts';
import type { createUpstreamBody, reorderUpstreamsBody, updateUpstreamBody, upstreamOptionsQuery } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { appendUpstream, saveUpstream } from '../shared/save-upstreams.ts';
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
import { type CodexQuotaSnapshotMap, type CodexUpstreamConfig, assertCodexUpstreamRecord, assertCodexUpstreamState, getCodexQuota, patchCodexIdentityMetadata } from '@floway-dev/provider-codex';
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
  record: StoredUpstreamRecord,
  knownProxyIds: ReadonlySet<string>,
  baseSerialize: (r: UpstreamRecord) => SerializedUpstreamRecord = upstreamRecordToJson,
  includeQuota = true,
): Promise<UpstreamWithCacheResponse> => {
  const codexQuota = includeQuota ? await codexQuotaForResponse(record) : {};
  const serialized = baseSerialize(record);
  return {
    ...serialized,
    proxy_fallback_list: pruneDeletedProxyEntries(serialized.proxy_fallback_list, knownProxyIds),
    modelsCache: modelsCacheStatus(record),
    ...codexQuota,
  };
};

const serializerForAccess = (access: UpstreamAccess): (record: UpstreamRecord) => SerializedUpstreamRecord =>
  access.edit === 'full' ? upstreamRecordToFullJson : upstreamRecordToJson;

const serializeForAccess = async (
  record: StoredUpstreamRecord,
  knownProxyIds: ReadonlySet<string>,
  access: UpstreamAccess,
): Promise<UpstreamWithCacheResponse> => await serializeForResponse(
  record,
  knownProxyIds,
  serializerForAccess(access),
  access.audit || access.edit === 'full',
);

const modelUseForUpstreams = async (
  c: AuthedContext,
  subject: ReturnType<typeof userFromContext>,
  items: readonly StoredUpstreamRecord[],
): Promise<boolean[] | null> => {
  if (subject.isAdmin) return null;
  const grants = await checkMany(subject, items.map(item => ({
    target: { kind: 'upstream' as const, upstreamId: item.id },
    requirement: { permission: 'Model.Use' as const },
  })));
  if (grants.every(Boolean)) return grants;
  const coverage = await enumerateAddressableModelIds(
    subject,
    effectiveUpstreamIdsFromContext(c),
    createModelsRefreshScheduler(getRuntimeLocation(c.req.raw), backgroundSchedulerFromContext(c)),
    [...items],
  );
  const covered = new Set(coverage.flatMap(entry => entry.upstreams.map(upstream => upstream.upstreamId)));
  return items.map((item, index) => grants[index]! || covered.has(item.id));
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

export const listUpstreams = async (c: AuthedContext) => {
  const subject = userFromContext(c);
  const [items, knownProxyIds] = await Promise.all([getRepo().upstreams.list(), loadKnownProxyIds()]);
  const accesses = await resolveUpstreamAccesses(subject, items.map(item => item.id));
  const modelUse = await modelUseForUpstreams(c, subject, items);
  const reorderGroups = new Map<string, string | null>();
  let reorderGroup: string | null = null;
  for (const item of items) {
    const full = accesses.get(item.id)!.edit === 'full';
    if (full && reorderGroup === null) reorderGroup = item.id;
    if (!full) reorderGroup = null;
    reorderGroups.set(item.id, reorderGroup);
  }
  return c.json(await Promise.all(items.flatMap((record, index) => {
    const access = accesses.get(record.id)!;
    if (!access.audit && access.edit === 'off') return [];
    return [serializeForResponse(record, knownProxyIds, upstreamRecordToJson)
      .then(serialized => ({ ...serialized, editLevel: access.edit, audit: access.audit, modelUse: modelUse === null || modelUse[index]!, reorderGroup: reorderGroups.get(record.id)! }))];
  })));
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const reorderUpstreams = async (c: CtxWithJson<typeof reorderUpstreamsBody>) => {
  const { expectedIds, ids } = c.req.valid('json');
  const repo = getRepo();
  const items = await repo.upstreams.list();
  const accesses = await resolveUpstreamAccesses(userFromContext(c), items.map(item => item.id));
  const anchor = items.findIndex(item => item.id === expectedIds[0]);
  if (anchor < 0 || accesses.get(items[anchor]!.id)?.edit !== 'full') {
    return c.json({ error: 'Upstreams changed or cross a Full-access boundary. Refresh before reordering.' }, 409);
  }

  let start = anchor;
  while (start > 0 && accesses.get(items[start - 1]!.id)?.edit === 'full') start -= 1;
  let end = anchor + 1;
  while (end < items.length && accesses.get(items[end]!.id)?.edit === 'full') end += 1;
  const segment = items.slice(start, end);
  if (!sameIds(segment.map(item => item.id), expectedIds)) {
    return c.json({ error: 'Upstreams changed or cross a Full-access boundary. Refresh before reordering.' }, 409);
  }

  const assignments = ids.map((id, index) => ({ id, sortOrder: segment[index]!.sortOrder }));
  const reordered = await repo.upstreams.reorder(items.map(item => item.id), assignments);
  return reordered === null
    ? c.json({ error: 'Upstreams changed or cross a Full-access boundary. Refresh before reordering.' }, 409)
    : c.json({ ok: true });
};

// Picker identities and model counts for key restrictions, Audit filters and
// admin selectors. Provider configuration, secrets and flag overrides are omitted.
export const listUpstreamOptions = async (c: CtxWithQuery<typeof upstreamOptionsQuery>) => {
  const items = await getRepo().upstreams.list();
  const subject = userFromContext(c);
  const view = c.req.valid('query').view ?? 'key';
  if (view === 'all' && !subject.isAdmin) return c.json({ error: 'Admin privileges required' }, 403);
  let visibleIds = new Set(items.map(item => item.id));
  if (!subject.isAdmin && view === 'audit') {
    const allowed = await checkMany(subject, items.map(item => ({
      target: { kind: 'upstream' as const, upstreamId: item.id },
      requirement: { permission: 'Upstream.Audit' as const },
    })));
    visibleIds = new Set(items.filter((_item, index) => allowed[index]).map(item => item.id));
  } else if (!subject.isAdmin && view === 'key') {
    // A key may only cap to a surface the data plane can route. Reuse the
    // addressable catalog rather than the raw stored rows: the latter still
    // contains operator-disabled models and would offer a dead upstream.
    const modelUse = await modelUseForUpstreams(c, subject, items);
    if (modelUse === null) throw new Error('Non-admin Model.Use resolution returned an admin projection');
    visibleIds = new Set(items.filter((_item, index) => modelUse[index]).map(item => item.id));
  }
  return c.json(items
    .filter(item => visibleIds.has(item.id))
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

// Full editors receive credentials for provider actions. Audit and models-only
// access receive the same complete redacted configuration. The stored catalog is
// attached without triggering model discovery, and only for callers whose
// Model.Use reaches this upstream: the catalog itself is not part of the
// configuration an auditor may read.
export const getUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const subject = userFromContext(c);
  const access = (await resolveUpstreamAccesses(subject, [id])).get(id)!;
  if (!access.audit && access.edit === 'off') return c.json({ error: 'upstream not found' }, 404);
  const [record, knownProxyIds] = await Promise.all([getRepo().upstreams.getById(id), loadKnownProxyIds()]);
  if (!record) return c.json({ error: 'upstream not found' }, 404);
  const modelUse = (await modelUseForUpstreams(c, subject, [record]))?.[0] ?? true;
  return c.json({
    ...await serializeForAccess(record, knownProxyIds, access),
    cachedModels: modelUse ? cachedModelsForDashboard(record) : null,
    editLevel: access.edit,
    audit: access.audit,
  });
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
    usageRefreshIntervalMinutes: body.usage_refresh_interval_minutes ?? 0,
    // The repo assigns the append rank atomically with the insert.
    sortOrder: 0,
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
  const saved = await appendUpstream(record);
  return c.json(await serializeForResponse(saved, knownProxyIds), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody, '/:id'>) => {
  const id = c.req.param('id');
  const subject = userFromContext(c);
  const editLevel = await resolveUpstreamEditLevel(subject, id);
  if (editLevel === 'off') return c.json({ error: 'Upstream not found' }, 404);
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = c.req.valid('json');
  if (editLevel === 'models') {
    const allowedTopLevel = new Set(['disabled_public_model_ids', 'config']);
    const blockedTopLevel = Object.keys(body).filter(key => !allowedTopLevel.has(key));
    if (blockedTopLevel.length > 0) {
      return c.json({ error: `Upstream.Edit.Models cannot change: ${blockedTopLevel.join(', ')}` }, 403);
    }
    if (body.config !== undefined) {
      if (!isRecord(body.config)) return c.json({ error: 'config must be an object' }, 400);
      const allowedConfig = existing.kind === 'custom' ? new Set(['models', 'modelsFetch']) : new Set(['models']);
      const blockedConfig = Object.keys(body.config).filter(key => !allowedConfig.has(key));
      if (blockedConfig.length > 0) {
        return c.json({ error: `Upstream.Edit.Models cannot change config: ${blockedConfig.join(', ')}` }, 403);
      }
      if (existing.kind !== 'custom' && existing.kind !== 'azure' && existing.kind !== 'ollama') {
        return c.json({ error: `Upstream.Edit.Models cannot change ${existing.kind} config` }, 403);
      }
      if (existing.kind === 'custom' && 'modelsFetch' in body.config) {
        const modelsFetch = body.config.modelsFetch;
        if (!isRecord(modelsFetch) || Object.keys(modelsFetch).some(key => key !== 'enabled')) {
          return c.json({ error: 'Upstream.Edit.Models can only change modelsFetch.enabled' }, 403);
        }
      }
    }
  }
  if (body.kind !== undefined && body.kind !== existing.kind) {
    return c.json({ error: 'kind cannot be changed' }, 400);
  }

  // OAuth-managed config slices (Copilot githubToken/user, Claude Code
  // accounts[]) are owned by the per-provider action endpoints, not by generic
  // PATCH. Full edits can change metadata here; models-only writes have passed
  // the narrower allowlist above.
  //
  // Codex full edits can correct an email or plan without replacing a working
  // credential. The account id stays bound to re-import because it is the
  // stored credential's join key.
  let patchedCodexConfig: CodexUpstreamConfig | undefined;
  if (body.config !== undefined && existing.kind === 'codex') {
    try {
      assertCodexUpstreamRecord(existing);
      patchedCodexConfig = patchCodexIdentityMetadata(existing.config, body.config);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  }
  if (body.config !== undefined && (existing.kind === 'copilot' || existing.kind === 'claude-code')) {
    const endpoint = existing.kind === 'copilot'
      ? '/api/upstreams/copilot/oauth/device-login/poll'
      : '/api/upstreams/claude-code/oauth/exchange';
    return c.json({ error: `Use POST ${endpoint} to update ${existing.kind} credentials` }, 400);
  }

  const knownProxyIds = await loadKnownProxyIds();
  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.usage_refresh_interval_minutes !== undefined) next = { ...next, usageRefreshIntervalMinutes: body.usage_refresh_interval_minutes };
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
    if (patchedCodexConfig !== undefined) {
      next = { ...next, config: patchedCodexConfig };
    } else {
      let configPatch = body.config;
      if (editLevel === 'models' && existing.kind === 'custom' && isRecord(body.config.modelsFetch)) {
        const custom = assertCustomUpstreamRecord(existing);
        configPatch = { ...body.config, modelsFetch: { ...custom.config.modelsFetch, ...body.config.modelsFetch } };
      }
      const config = mergeConfigPatch(existing.kind, existing.config, configPatch);
      if (!config.ok) return c.json({ error: config.error }, 400);
      next = { ...next, config: config.value };
    }
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };

  const saved = await saveUpstream({ previous: existing, next });
  const access = (await resolveUpstreamAccesses(subject, [id])).get(id)!;
  return c.json({
    ...await serializeForAccess(saved, knownProxyIds, access),
    editLevel,
    audit: access.audit,
  });
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
