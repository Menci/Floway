import type { Context } from 'hono';

import { loadCachedModelsForDashboard, modelsCacheStatus } from './models-cache-projection.ts';
import { blueprintUpstreamRecord, upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { FullSerializedUpstreamRecord, ModelsCacheStatus, RedactedSerializedUpstreamRecord } from './types.ts';
import { checkMany } from '../../access-control/check.ts';
import { type UpstreamAccess, resolveUpstreamAccesses, resolveUpstreamEditLevel } from '../../access-control/upstream-edit.ts';
import { supportsManualModels } from '../../execution/models-refresh.ts';
import { type AuthedContext, effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import type { StoredUpstreamMeta, StoredUpstreamRecord } from '../../repo/types.ts';
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
  type UpstreamModelConfig,
  type UpstreamProviderKind,
  type UpstreamRecord,
} from '@floway-dev/provider';
import { assertAzureUpstreamRecord, validateAzureManualModels } from '@floway-dev/provider-azure';
import { type ChatGPTQuotaSnapshotMap, type ChatGPTUpstreamConfig, assertChatGPTUpstreamRecord, assertChatGPTUpstreamState, getChatGPTQuota, patchChatGPTIdentityMetadata } from '@floway-dev/provider-chatgpt';
import { assertClaudeCodeUpstreamRecord, readClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { parseCopilotUpstreamConfig, readCopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, validateCustomManualModels } from '@floway-dev/provider-custom';
import { assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from '@floway-dev/provider-kimi-code';
import { assertOllamaUpstreamRecord, validateOllamaManualModels } from '@floway-dev/provider-ollama';

type ChatGPTQuotaProjection = { chatgpt_quota?: ChatGPTQuotaSnapshotMap | null };

type SerializedUpstreamRecord = FullSerializedUpstreamRecord | RedactedSerializedUpstreamRecord;

type UpstreamResponse = SerializedUpstreamRecord & ChatGPTQuotaProjection;

type UpstreamWithCacheResponse = UpstreamResponse & {
  modelsCache: ModelsCacheStatus;
};

const chatgptQuotaForResponse = async (record: UpstreamRecord): Promise<ChatGPTQuotaProjection> => {
  if (record.kind !== 'chatgpt') return {};
  assertChatGPTUpstreamRecord(record);
  return {
    chatgpt_quota: await getChatGPTQuota(record.id, record.config.accounts[0].chatgptAccountId),
  };
};

const loadKnownProxyIds = async (): Promise<ReadonlySet<string>> =>
  new Set((await getRepo().proxies.list()).map(proxy => proxy.id));

const pruneDeletedProxyEntries = (
  entries: readonly ProxyFallbackEntry[],
  knownProxyIds: ReadonlySet<string>,
): ProxyFallbackEntry[] => entries.filter(entry => isDirectFallbackId(entry.id) || knownProxyIds.has(entry.id));

const serializeForResponse = async (
  record: StoredUpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
  modelCount: number | null,
  knownProxyIds: ReadonlySet<string>,
  baseSerialize: (r: UpstreamRecord, models?: readonly UpstreamModelConfig[]) => SerializedUpstreamRecord = upstreamRecordToJson,
  includeQuota = true,
): Promise<UpstreamWithCacheResponse> => {
  const chatgptQuota = includeQuota ? await chatgptQuotaForResponse(record) : {};
  const serialized = baseSerialize(record, manualModels);
  return {
    ...serialized,
    proxy_fallback_list: pruneDeletedProxyEntries(serialized.proxy_fallback_list, knownProxyIds),
    modelsCache: modelsCacheStatus(record, modelCount),
    ...chatgptQuota,
  };
};

const serializerForAccess = (access: UpstreamAccess): (record: UpstreamRecord, models?: readonly UpstreamModelConfig[]) => SerializedUpstreamRecord =>
  access.edit === 'full' ? upstreamRecordToFullJson : upstreamRecordToJson;

const serializeForAccess = async (
  record: StoredUpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
  modelCount: number | null,
  knownProxyIds: ReadonlySet<string>,
  access: UpstreamAccess,
): Promise<UpstreamWithCacheResponse> => await serializeForResponse(
  record,
  manualModels,
  modelCount,
  knownProxyIds,
  serializerForAccess(access),
  access.audit || access.edit === 'full',
);

const modelUseForUpstreams = async (
  c: AuthedContext,
  subject: ReturnType<typeof userFromContext>,
  items: readonly Pick<StoredUpstreamMeta, 'id'>[],
): Promise<boolean[] | null> => {
  if (subject.isAdmin) return null;
  const grants = await checkMany(subject, items.map(item => ({
    target: { kind: 'upstream' as const, upstreamId: item.id },
    requirement: { permission: 'Model.Use' as const },
  })));
  if (grants.every(Boolean)) return grants;

  const effectiveScope = effectiveUpstreamIdsFromContext(c);
  const scopeSet = effectiveScope === null ? null : new Set(effectiveScope);
  const pendingIds = items
    .filter((item, index) => !grants[index] && (scopeSet === null || scopeSet.has(item.id)))
    .map(item => item.id);
  if (pendingIds.length === 0) return grants;

  const addressable = await getRepo().upstreamModels.listAddressableIdsForUpstreams(pendingIds);
  if (addressable.length === 0) return grants;

  const allowed = await checkMany(subject, addressable.map(entry => ({
    target: { kind: 'upstreamModel' as const, upstreamId: entry.upstreamId, model: { kind: 'exact' as const, value: entry.addressableId } },
    requirement: { permission: 'Model.Use' as const },
  })));
  const covered = new Set<string>();
  for (let index = 0; index < addressable.length; index++) {
    if (allowed[index]) covered.add(addressable[index]!.upstreamId);
  }
  return items.map((item, index) => grants[index]! || covered.has(item.id));
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const extractAndValidateManualModels = (
  kind: UpstreamProviderKind,
  rawConfig: unknown,
  fallbackManualModels?: readonly UpstreamModelConfig[],
): ValidationResult<{ readonly config: unknown; readonly manualModels?: UpstreamModelConfig[] }> => {
  if (!supportsManualModels(kind)) return { ok: true, value: { config: rawConfig } };
  if (!isRecord(rawConfig)) return { ok: false, error: `Malformed ${kind} upstream config: config must be an object` };
  const hasModelsKey = Object.prototype.hasOwnProperty.call(rawConfig, 'models');
  const { models: rawModels, ...restConfig } = rawConfig;
  const candidateModels = hasModelsKey ? rawModels : fallbackManualModels;
  try {
    const manualModels = kind === 'azure'
      ? validateAzureManualModels(candidateModels)
      : kind === 'custom'
        ? validateCustomManualModels(candidateModels)
        : validateOllamaManualModels(candidateModels);
    return { ok: true, value: { config: restConfig, manualModels } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const normalizeConfig = (record: UpstreamRecord): ValidationResult<unknown> => {
  try {
    if (record.kind === 'custom') return { ok: true, value: assertCustomUpstreamRecord(record).config };
    if (record.kind === 'azure') return { ok: true, value: assertAzureUpstreamRecord(record).config };
    if (record.kind === 'kimi-code') return { ok: true, value: assertKimiCodeUpstreamRecord(record).config };
    if (record.kind === 'ollama') return { ok: true, value: assertOllamaUpstreamRecord(record).config };
    if (record.kind === 'chatgpt') {
      assertChatGPTUpstreamRecord(record);
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
  }
  return { ok: true, value: next };
};

const normalizeModelPrefixField = (input: unknown): ValidationResult<ModelPrefixConfig | null> => {
  try {
    return { ok: true, value: normalizeModelPrefix(input) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
};

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
  const repo = getRepo();
  const [items, knownProxyIds, counts] = await Promise.all([
    repo.upstreams.list(),
    loadKnownProxyIds(),
    repo.upstreamModels.countListedByUpstream(),
  ]);
  const accesses = await resolveUpstreamAccesses(subject, items.map(item => item.id));
  const modelUse = await modelUseForUpstreams(c, subject, items);
  const visibleManualUpstreamIds = items
    .filter(item => {
      const access = accesses.get(item.id)!;
      return (access.audit || access.edit !== 'off') && supportsManualModels(item.kind);
    })
    .map(item => item.id);
  const manualModelsByUpstream = await repo.upstreamModels.listManualModelsByUpstreams(visibleManualUpstreamIds);

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
    const manualModels = manualModelsByUpstream.get(record.id) ?? [];
    const modelCount = counts.get(record.id) ?? null;
    return [serializeForResponse(record, manualModels, modelCount, knownProxyIds, upstreamRecordToJson)
      .then(serialized => ({ ...serialized, editLevel: access.edit, audit: access.audit, modelUse: modelUse === null || modelUse[index]!, reorderGroup: reorderGroups.get(record.id)! }))];
  })));
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const reorderUpstreams = async (c: CtxWithJson<typeof reorderUpstreamsBody>) => {
  const { expectedIds, ids } = c.req.valid('json');
  const repo = getRepo();
  const items = await repo.upstreams.listMeta();
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

export const listUpstreamOptions = async (c: CtxWithQuery<typeof upstreamOptionsQuery>) => {
  const repo = getRepo();
  const items = await repo.upstreams.listMeta();
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
    const modelUse = await modelUseForUpstreams(c, subject, items);
    if (modelUse === null) throw new Error('Non-admin Model.Use resolution returned an admin projection');
    visibleIds = new Set(items.filter((_item, index) => modelUse[index]).map(item => item.id));
  }
  const visible = items
    .filter(item => visibleIds.has(item.id))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const counts = await repo.upstreamModels.countListedByUpstream(visible.map(item => item.id));
  return c.json(visible.map(upstream => ({
    id: upstream.id,
    name: upstream.name,
    kind: upstream.kind,
    enabled: upstream.enabled,
    hue: upstream.hue,
    cachedModelCount: counts.get(upstream.id) ?? null,
  })));
};

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

export const getUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const subject = userFromContext(c);
  const access = (await resolveUpstreamAccesses(subject, [id])).get(id)!;
  if (!access.audit && access.edit === 'off') return c.json({ error: 'upstream not found' }, 404);
  const repo = getRepo();
  const [record, knownProxyIds, counts] = await Promise.all([
    repo.upstreams.getById(id),
    loadKnownProxyIds(),
    repo.upstreamModels.countListedByUpstream([id]),
  ]);
  if (!record) return c.json({ error: 'upstream not found' }, 404);
  const [manualModels, modelUse] = await Promise.all([
    supportsManualModels(record.kind) ? repo.upstreamModels.listManualModels(id) : Promise.resolve([]),
    modelUseForUpstreams(c, subject, [record]).then(values => values?.[0] ?? true),
  ]);
  const cachedModels = modelUse ? await loadCachedModelsForDashboard(record) : null;
  return c.json({
    ...await serializeForAccess(record, manualModels, counts.get(id) ?? null, knownProxyIds, access),
    cachedModels,
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

  const extracted = extractAndValidateManualModels(body.kind, body.config);
  if (!extracted.ok) return c.json({ error: extracted.error }, 400);

  const now = new Date().toISOString();
  const stateFromBody = body.kind === 'copilot' || body.kind === 'chatgpt' || body.kind === 'claude-code' ? body.state ?? null : null;
  const upstream: UpstreamRecord = {
    id: shortId('up'),
    kind: body.kind,
    name: body.name,
    enabled: body.enabled ?? true,
    usageRefreshIntervalMinutes: body.usage_refresh_interval_minutes ?? 0,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    proxyFallbackList,
    modelPrefix,
    hue: body.hue,
    config: extracted.value.config,
    state: stateFromBody,
  };

  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  try {
    if (upstream.kind === 'copilot') readCopilotUpstreamState(stateFromBody);
    else if (upstream.kind === 'chatgpt') assertChatGPTUpstreamState(stateFromBody);
    else if (upstream.kind === 'claude-code') readClaudeCodeUpstreamState(stateFromBody);
  } catch (err) {
    return c.json({ error: `Invalid state for ${upstream.kind}: ${errorMessage(err)}` }, 400);
  }

  const record = { ...upstream, config: config.value };
  const manualModels = extracted.value.manualModels;
  const saved = await appendUpstream(record, {
    ...(manualModels !== undefined ? { manualModels } : {}),
    refreshContext: {
      runtimeLocation: getRuntimeLocation(c.req.raw),
      scheduler: backgroundSchedulerFromContext(c),
    },
  });
  const counts = await getRepo().upstreamModels.countListedByUpstream([saved.id]);
  return c.json(await serializeForResponse(saved, manualModels ?? [], counts.get(saved.id) ?? null, knownProxyIds), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody, '/:id'>) => {
  const id = c.req.param('id');
  const subject = userFromContext(c);
  const editLevel = await resolveUpstreamEditLevel(subject, id);
  if (editLevel === 'off') return c.json({ error: 'Upstream not found' }, 404);
  const repo = getRepo();
  const existing = await repo.upstreams.getById(id);
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

  let patchedChatGPTConfig: ChatGPTUpstreamConfig | undefined;
  if (body.config !== undefined && existing.kind === 'chatgpt') {
    try {
      assertChatGPTUpstreamRecord(existing);
      patchedChatGPTConfig = patchChatGPTIdentityMetadata(existing.config, body.config);
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

  const [knownProxyIds, existingManualModels] = await Promise.all([
    loadKnownProxyIds(),
    supportsManualModels(existing.kind) ? repo.upstreamModels.listManualModels(id) : Promise.resolve([]),
  ]);

  let next: UpstreamRecord = {
    id: existing.id,
    kind: existing.kind,
    name: existing.name,
    enabled: existing.enabled,
    usageRefreshIntervalMinutes: existing.usageRefreshIntervalMinutes,
    sortOrder: existing.sortOrder,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    config: existing.config,
    state: existing.state,
    flagOverrides: existing.flagOverrides,
    disabledPublicModelIds: existing.disabledPublicModelIds,
    proxyFallbackList: existing.proxyFallbackList,
    modelPrefix: existing.modelPrefix,
    hue: existing.hue,
  };
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

  let nextManualModels: UpstreamModelConfig[] | undefined;
  if (body.config !== undefined) {
    if (patchedChatGPTConfig !== undefined) {
      next = { ...next, config: patchedChatGPTConfig };
    } else {
      let configPatch = body.config;
      if (editLevel === 'models' && existing.kind === 'custom' && isRecord(body.config.modelsFetch)) {
        const custom = assertCustomUpstreamRecord(existing);
        configPatch = { ...body.config, modelsFetch: { ...custom.config.modelsFetch, ...body.config.modelsFetch } };
      }
      const merged = mergeConfigPatch(existing.kind, existing.config, configPatch);
      if (!merged.ok) return c.json({ error: merged.error }, 400);
      const extracted = extractAndValidateManualModels(existing.kind, merged.value, existingManualModels);
      if (!extracted.ok) return c.json({ error: extracted.error }, 400);
      next = { ...next, config: extracted.value.config };
      nextManualModels = extracted.value.manualModels;
    }
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };
  if (next.kind === 'kimi-code' && !kimiCodeStateSurvivesConfigChange(existing.config, next.config as KimiCodeUpstreamConfig)) {
    next = { ...next, state: null };
  }

  const saved = await saveUpstream({
    previous: existing,
    next,
    ...(nextManualModels !== undefined ? { manualModels: nextManualModels } : {}),
    refreshContext: {
      runtimeLocation: getRuntimeLocation(c.req.raw),
      scheduler: backgroundSchedulerFromContext(c),
    },
  });
  const [access, counts] = await Promise.all([
    resolveUpstreamAccesses(subject, [id]).then(map => map.get(id)!),
    repo.upstreamModels.countListedByUpstream([id]),
  ]);
  return c.json({
    ...await serializeForAccess(saved, nextManualModels ?? existingManualModels, counts.get(id) ?? null, knownProxyIds, access),
    editLevel,
    audit: access.audit,
  });
};

export const deleteUpstream = async (c: AuthedContext<'/:id'>) => {
  const id = c.req.param('id');
  const repo = getRepo();
  const deleted = await repo.upstreams.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  return c.json({ ok: true });
};
