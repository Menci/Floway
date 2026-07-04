// Data transfer routes — export/import operator-managed database data as JSON.
//
// Ephemeral stored Responses state is omitted from exports and cleared on
// replace imports; clients can regenerate it through normal Responses use.
//
// The export contains every credential the gateway holds — provider API keys,
// GitHub tokens, Codex refresh tokens, and proxy URIs that embed passwords /
// UUIDs / PSKs. The endpoint is admin-only via x-api-key; operators are
// responsible for handling the dumped file with the same care as a DB backup.

import type { Context } from 'hono';

import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProviderInstance } from '../../data-plane/providers/registry.ts';
import { parseSearchConfigDefault, parseSearchConfigStrict } from '../../data-plane/tools/web-search/search-config.ts';
import type { SearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getDumpStore, notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { parseDisabledPublicModelIdsWire } from '../../repo/disabled-public-models.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_PROXY_ID, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import type { ApiKey, PerformanceMetricScope, PerformanceTelemetryRecord, SearchUsageRecord, TokenUsage, UsageRecord, User } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { PASSWORD_HASH_SCHEME } from '../../shared/passwords.ts';
import { isWebSearchProviderName } from '../../shared/web-search-providers.ts';
import { parseUpstreamIdsValue } from '../api-keys/upstream-ids.ts';
import { USERNAME_PATTERN, type exportQuery, type importBody, DUMP_RETENTION_MAX_SECONDS } from '../schemas.ts';
import { copilotConfigField, isRecord, nonEmptyStringField } from '../shared/field-validators.ts';
import { type SerializedUpstreamRecord, upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import { BILLING_DIMENSIONS, type ModelPricing } from '@floway-dev/protocols/common';
import { ALL_PROVIDER_KINDS, normalizeModelPrefix, parseFlagOverridesWire } from '@floway-dev/provider';
import type { ProxyFallbackEntry, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import { assertClaudeCodeUpstreamRecord, assertClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { assertCodexUpstreamRecord, assertCodexUpstreamState } from '@floway-dev/provider-codex';
import { assertCursorUpstreamRecord, assertCursorUpstreamState } from '@floway-dev/provider-cursor';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { parseProxyUri } from '@floway-dev/proxy';

// Wire shape of a proxy entry in the export/import payload. The backoff rows
// are deliberately excluded — they describe what this deployment saw, not
// what the operator configured.
interface SerializedProxy {
  id: string;
  name: string;
  url: string;
  dial_timeout_seconds: number | null;
}

interface ExportPayload {
  version: 6;
  exportedAt: string;
  data: {
    users: User[];
    apiKeys: ApiKey[];
    upstreams: SerializedUpstreamRecord[];
    proxies: SerializedProxy[];
    usage: UsageRecord[];
    searchUsage: SearchUsageRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded: boolean;
    searchConfig: SearchConfig;
  };
}

const EXPORT_VERSION = 6;
const SEARCH_USAGE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const PERFORMANCE_METRIC_SCOPES = new Set<PerformanceMetricScope>(['request_total', 'upstream_success']);
const UPSTREAM_PROVIDERS = new Set<UpstreamProviderKind>(ALL_PROVIDER_KINDS);
const LEGACY_UPSTREAM_PREFIXES = ['openai:', 'copilot:'];

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const isLegacyUpstreamIdentity = (value: string): boolean => LEGACY_UPSTREAM_PREFIXES.some(prefix => value.startsWith(prefix));

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPerformanceMetricScope = (value: unknown): value is PerformanceMetricScope => typeof value === 'string' && PERFORMANCE_METRIC_SCOPES.has(value as PerformanceMetricScope);

const importErrorBuilder = (field: string, expected: string) => new Error(`${field} must be ${expected}`);

const nonEmptyString = (value: unknown, field: string): string => nonEmptyStringField(value, field, importErrorBuilder);

const normalizeUpstreamConfig = (record: UpstreamRecord): unknown => {
  if (record.kind === 'custom') return assertCustomUpstreamRecord(record).config;
  if (record.kind === 'azure') return assertAzureUpstreamRecord(record).config;
  if (record.kind === 'codex') {
    assertCodexUpstreamRecord(record);
    return record.config;
  }
  if (record.kind === 'claude-code') {
    assertClaudeCodeUpstreamRecord(record);
    return record.config;
  }
  if (record.kind === 'cursor') {
    assertCursorUpstreamRecord(record);
    return record.config;
  }
  return copilotConfigField(record.config, importErrorBuilder);
};

// State is persisted only for providers that own autonomous runtime state.
// Codex rotates a refresh_token and tracks credential health; Claude Code
// holds per-account refresh tokens, OAuth-minted access tokens, and quota
// snapshots; Custom/Azure/Copilot have no such state and serialize to null.
// Round-trip the stateful providers through the same shape assertion the
// runtime uses so a corrupt or hand-edited import can't smuggle unknown
// fields onto the column.
const normalizeUpstreamState = (provider: UpstreamProviderKind, value: unknown): unknown => {
  if (provider !== 'codex' && provider !== 'claude-code' && provider !== 'cursor') return null;
  if (value === null || value === undefined) {
    throw new Error(`${provider} upstream is missing state — re-export with current code`);
  }
  if (provider === 'codex') assertCodexUpstreamState(value);
  else if (provider === 'claude-code') assertClaudeCodeUpstreamState(value);
  else assertCursorUpstreamState(value);
  return value;
};

const parseProxyFallbackListField = (value: unknown): ProxyFallbackEntry[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('proxy_fallback_list must be an array');
  const entries: ProxyFallbackEntry[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('proxy_fallback_list entries must be objects');
    }
    const entry = raw as { id?: unknown; colos?: unknown };
    if (typeof entry.id !== 'string') throw new Error('proxy_fallback_list entry .id must be a string');
    let colos: string[] | undefined;
    if (entry.colos !== undefined) {
      if (!Array.isArray(entry.colos)) throw new Error('proxy_fallback_list entry .colos must be an array');
      const list: string[] = [];
      for (const c of entry.colos) {
        if (typeof c !== 'string') throw new Error('proxy_fallback_list entry .colos members must be strings');
        list.push(c);
      }
      colos = list;
    }
    entries.push(colos === undefined ? { id: entry.id } : { id: entry.id, colos });
  }
  return normalizeProxyFallbackList(entries);
};

const parseUpstreamRecords = (value: unknown): { type: 'ok'; records: UpstreamRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'upstreams must be an array' };

  const records: UpstreamRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    try {
      const item = value[i];
      if (!isRecord(item)) throw new Error('record must be an object');
      if (hasOwn(item, 'enabled_fixes')) {
        throw new Error("legacy 'enabled_fixes' field is no longer supported; re-export with current code");
      }
      if (typeof item.kind !== 'string' || !UPSTREAM_PROVIDERS.has(item.kind as UpstreamProviderKind)) {
        throw new Error(`kind must be one of ${ALL_PROVIDER_KINDS.join(', ')}`);
      }
      if (typeof item.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      if (typeof item.sort_order !== 'number' || !Number.isFinite(item.sort_order)) throw new Error('sort_order must be a finite number');

      const id = nonEmptyString(item.id, 'id');
      if (isLegacyUpstreamIdentity(id)) throw new Error('id must use a raw upstream id, not a legacy provider-prefixed identity');

      const kind = item.kind as UpstreamProviderKind;
      const record: UpstreamRecord = {
        id,
        kind,
        name: nonEmptyString(item.name, 'name'),
        enabled: item.enabled,
        sortOrder: Math.floor(item.sort_order),
        createdAt: nonEmptyString(item.created_at, 'created_at'),
        updatedAt: nonEmptyString(item.updated_at, 'updated_at'),
        flagOverrides: parseFlagOverridesWire(item.flag_overrides),
        disabledPublicModelIds: parseDisabledPublicModelIdsWire(item.disabled_public_model_ids),
        proxyFallbackList: parseProxyFallbackListField(item.proxy_fallback_list),
        modelPrefix: normalizeModelPrefix(item.model_prefix),
        config: item.config,
        state: normalizeUpstreamState(kind, item.state),
      };
      records.push({ ...record, config: normalizeUpstreamConfig(record) });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const parseProxyRecords = (value: unknown): { type: 'ok'; records: SerializedProxy[] } | { type: 'invalid'; index: number; error: string } => {
  // Proxies are optional in the import contract: an absent or empty array
  // means "the source deployment had no proxies".
  if (value === undefined) return { type: 'ok', records: [] };
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'proxies must be an array' };

  const records: SerializedProxy[] = [];
  for (let i = 0; i < value.length; i++) {
    try {
      const item = value[i];
      if (!isRecord(item)) throw new Error('record must be an object');
      const id = nonEmptyString(item.id, 'id');
      if (id === DIRECT_PROXY_ID) throw new Error(`id must not be the reserved '${DIRECT_PROXY_ID}' sentinel`);
      const name = nonEmptyString(item.name, 'name');
      const url = nonEmptyString(item.url, 'url');
      try {
        parseProxyUri(url);
      } catch (err) {
        throw new Error(`url did not parse: ${err instanceof Error ? err.message : String(err)}`);
      }
      const dialTimeoutSeconds = item.dial_timeout_seconds;
      if (dialTimeoutSeconds !== null && (typeof dialTimeoutSeconds !== 'number' || !Number.isInteger(dialTimeoutSeconds) || dialTimeoutSeconds < 1)) {
        throw new Error('dial_timeout_seconds must be null or a positive integer');
      }
      records.push({ id, name, url, dial_timeout_seconds: dialTimeoutSeconds });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const validateProxyIdentities = (records: readonly SerializedProxy[]): string | null => {
  const seen = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const prior = seen.get(records[i].id);
    if (prior !== undefined) return `duplicate proxies id ${records[i].id} at indexes ${prior} and ${i}`;
    seen.set(records[i].id, i);
  }
  return null;
};

// Every entry in every upstream's proxy_fallback_list must resolve to a proxy
// id that will exist after the import completes — that is, an imported proxy,
// an existing local proxy (merge mode only; replace mode wipes them first),
// or the 'direct' sentinel. A dangling reference would silently disable that
// fallback in the dial layer, which is exactly the silent-truncation
// behavior the import contract is supposed to prevent.
const validateProxyFallbackReferences = (
  upstreams: readonly UpstreamRecord[],
  proxies: readonly SerializedProxy[],
  existingProxyIds: readonly string[],
): string | null => {
  const knownIds = new Set<string>(proxies.map(p => p.id));
  for (const id of existingProxyIds) knownIds.add(id);
  knownIds.add(DIRECT_PROXY_ID);
  for (const upstream of upstreams) {
    for (const ref of upstream.proxyFallbackList) {
      if (!knownIds.has(ref.id)) {
        return `upstream ${upstream.id} references unknown proxy ${ref.id}`;
      }
    }
  }
  return null;
};

const parseImportedDumpRetention = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > DUMP_RETENTION_MAX_SECONDS) {
    throw new Error(`dumpRetentionSeconds must be null or a positive integer up to ${DUMP_RETENTION_MAX_SECONDS}`);
  }
  return value;
};

const parseApiKeyRecords = (value: unknown): { type: 'ok'; records: ApiKey[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'apiKeys must be an array' };

  const records: ApiKey[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!isRecord(record)) return { type: 'invalid', index: i, error: 'record must be an object' };
    try {
      const upstreamIdsParsed = parseUpstreamIdsValue(record.upstreamIds);
      if (!upstreamIdsParsed.ok) throw new Error(upstreamIdsParsed.error);

      if (typeof record.userId !== 'number' || !Number.isInteger(record.userId) || record.userId < 1) {
        throw new Error('userId must be a positive integer');
      }
      if (record.deletedAt !== null && typeof record.deletedAt !== 'string') {
        throw new Error('deletedAt must be null or an ISO string');
      }
      records.push({
        id: nonEmptyString(record.id, 'id'),
        userId: record.userId,
        name: nonEmptyString(record.name, 'name'),
        key: nonEmptyString(record.key, 'key'),
        createdAt: nonEmptyString(record.createdAt, 'createdAt'),
        ...(record.lastUsedAt !== undefined ? { lastUsedAt: nonEmptyString(record.lastUsedAt, 'lastUsedAt') } : {}),
        upstreamIds: upstreamIdsParsed.value,
        deletedAt: record.deletedAt,
        dumpRetentionSeconds: parseImportedDumpRetention(record.dumpRetentionSeconds),
      });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const parseUserRecords = (value: unknown): { type: 'ok'; records: User[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'users must be an array' };

  const records: User[] = [];
  const seenIds = new Set<number>();
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!isRecord(record)) return { type: 'invalid', index: i, error: 'record must be an object' };
    try {
      if (typeof record.id !== 'number' || !Number.isInteger(record.id) || record.id < 1) {
        throw new Error('id must be a positive integer');
      }
      if (seenIds.has(record.id)) throw new Error(`duplicate user id ${record.id}`);
      seenIds.add(record.id);

      if (typeof record.username !== 'string' || !USERNAME_PATTERN.test(record.username)) {
        throw new Error('username must match ^[a-zA-Z0-9_.-]{1,64}$');
      }
      if (record.passwordHash !== null && (typeof record.passwordHash !== 'string' || !record.passwordHash.startsWith(`${PASSWORD_HASH_SCHEME}$`))) {
        throw new Error(`passwordHash must be null or start with ${PASSWORD_HASH_SCHEME}$`);
      }
      if (typeof record.isAdmin !== 'boolean') throw new Error('isAdmin must be a boolean');
      if (typeof record.canViewGlobalTelemetry !== 'boolean') throw new Error('canViewGlobalTelemetry must be a boolean');

      if (record.upstreamIds === undefined) throw new Error('upstreamIds must be present (null or array)');
      const upstreamIdsParsed = parseUpstreamIdsValue(record.upstreamIds);
      if (!upstreamIdsParsed.ok) throw new Error(upstreamIdsParsed.error);
      if (record.deletedAt !== null && typeof record.deletedAt !== 'string') {
        throw new Error('deletedAt must be null or an ISO string');
      }

      records.push({
        id: record.id,
        username: record.username,
        passwordHash: record.passwordHash,
        isAdmin: record.isAdmin,
        upstreamIds: upstreamIdsParsed.value,
        canViewGlobalTelemetry: record.canViewGlobalTelemetry,
        createdAt: nonEmptyString(record.createdAt, 'createdAt'),
        deletedAt: record.deletedAt,
      });
    } catch (error) {
      return { type: 'invalid', index: i, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { type: 'ok', records };
};

const validateApiKeyIdentities = (records: readonly ApiKey[], existing: readonly ApiKey[], mode: 'merge' | 'replace'): string | null => {
  const ids = new Map<string, number>();
  const rawKeys = new Map<string, string>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const existingIdIndex = ids.get(record.id);
    if (existingIdIndex !== undefined) return `duplicate apiKeys id ${record.id} at indexes ${existingIdIndex} and ${i}`;
    ids.set(record.id, i);

    const existingRawKeyId = rawKeys.get(record.key);
    if (existingRawKeyId !== undefined) return `duplicate apiKeys raw key used by ${existingRawKeyId} and ${record.id}`;
    rawKeys.set(record.key, record.id);
  }

  if (mode === 'merge') {
    const existingRawKeys = new Map(existing.map(record => [record.key, record.id]));
    for (const record of records) {
      const existingId = existingRawKeys.get(record.key);
      if (existingId !== undefined && existingId !== record.id) {
        return `apiKeys raw key for ${record.id} conflicts with existing api key ${existingId}`;
      }
    }
  }

  return null;
};

const parseImportedCost = (value: unknown): { type: 'ok'; cost: UsageRecord['cost'] } | { type: 'invalid' } => {
  if (value === undefined || value === null) return { type: 'ok', cost: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { type: 'invalid' };
  const obj = value as Record<string, unknown>;
  const cost: ModelPricing = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const rate = obj[dimension];
    if (rate === undefined) continue;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return { type: 'invalid' };
    cost[dimension] = rate;
  }
  return { type: 'ok', cost: Object.keys(cost).length > 0 ? cost : null };
};

const parseImportedTokens = (value: unknown): { type: 'ok'; tokens: TokenUsage } | { type: 'invalid' } => {
  if (value === undefined || value === null) return { type: 'ok', tokens: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { type: 'invalid' };
  const obj = value as Record<string, unknown>;
  const tokens: TokenUsage = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const count = obj[dimension];
    if (count === undefined) continue;
    if (!isNonNegativeSafeInteger(count)) return { type: 'invalid' };
    if (count > 0) tokens[dimension] = count;
  }
  return { type: 'ok', tokens };
};

const parseUsageRecords = (value: unknown): { type: 'ok'; records: UsageRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'usage must be an array' };

  const records: UsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!isRecord(record)) return { type: 'invalid', index: i, error: 'record must be an object' };
    if (
      typeof record.keyId !== 'string' ||
      record.keyId.length === 0 ||
      typeof record.model !== 'string' ||
      record.model.length === 0 ||
      (record.upstream !== null && typeof record.upstream !== 'string') ||
      typeof record.modelKey !== 'string' ||
      record.modelKey.length === 0 ||
      typeof record.hour !== 'string' ||
      !SEARCH_USAGE_HOUR_PATTERN.test(record.hour) ||
      !isNonNegativeSafeInteger(record.requests)
    ) {
      return { type: 'invalid', index: i, error: 'record has invalid usage fields' };
    }
    if (typeof record.upstream === 'string' && isLegacyUpstreamIdentity(record.upstream)) {
      return { type: 'invalid', index: i, error: 'upstream must use a raw upstream id, not a legacy provider-prefixed identity' };
    }
    if (record.tier !== undefined && record.tier !== null && typeof record.tier !== 'string') {
      return { type: 'invalid', index: i, error: 'tier, when present, must be a string or null' };
    }
    if (record.tier === '') {
      return { type: 'invalid', index: i, error: 'tier must be a non-empty string or null/absent' };
    }
    // Empty-string is rejected rather than normalized to null: the unique
    // index folds NULL/'' under COALESCE, so a '' import would silently
    // merge with base-tier rows.
    const tier: string | null = typeof record.tier === 'string' ? record.tier : null;
    const tokensResult = parseImportedTokens(record.tokens);
    if (tokensResult.type === 'invalid') return { type: 'invalid', index: i, error: 'record has invalid token dimension counts' };
    const costResult = parseImportedCost(record.cost);
    if (costResult.type === 'invalid') return { type: 'invalid', index: i, error: 'record has invalid cost dimension rates' };
    records.push({
      keyId: record.keyId,
      model: record.model,
      upstream: record.upstream,
      modelKey: record.modelKey,
      hour: record.hour,
      tier,
      requests: record.requests,
      tokens: tokensResult.tokens,
      cost: costResult.cost,
    });
  }

  return { type: 'ok', records };
};

const parseSearchUsageRecords = (value: unknown): { type: 'ok'; records: SearchUsageRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'searchUsage must be an array' };

  const records: SearchUsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== 'object') return { type: 'invalid', index: i, error: 'record must be an object' };

    const item = record as Record<string, unknown>;
    const provider = item.provider;
    const keyId = item.keyId;
    const action = item.action;
    const hour = item.hour;
    const requests = item.requests;
    if (!isWebSearchProviderName(provider)) return { type: 'invalid', index: i, error: 'invalid provider' };
    if (typeof keyId !== 'string' || keyId.length === 0) return { type: 'invalid', index: i, error: 'keyId must be a non-empty string' };
    if (action !== 'search' && action !== 'fetch_page') return { type: 'invalid', index: i, error: 'action must be "search" or "fetch_page"' };
    if (typeof hour !== 'string' || !SEARCH_USAGE_HOUR_PATTERN.test(hour)) return { type: 'invalid', index: i, error: 'hour must match the SEARCH_USAGE_HOUR_PATTERN' };
    if (typeof requests !== 'number' || !Number.isSafeInteger(requests) || requests < 0) return { type: 'invalid', index: i, error: 'requests must be a non-negative safe integer' };

    records.push({ provider, keyId, action, hour, requests });
  }

  return { type: 'ok', records };
};

const parseSearchConfig = (value: unknown): { type: 'ok'; config: SearchConfig } | { type: 'invalid'; error: string } => {
  // Delegate to the shared strict parser so the import layer and the
  // load/save helpers cannot drift on what counts as a valid stored
  // config. The strict parser throws a descriptive Error; we map that
  // back into the route's structured invalid envelope here.
  try {
    return { type: 'ok', config: parseSearchConfigStrict(value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: 'invalid', error: message };
  }
};

const parsePerformanceIncluded = (data: Record<string, unknown>): { type: 'ok'; included: boolean } | { type: 'invalid'; error: string } => {
  if (typeof data.performanceIncluded !== 'boolean') return { type: 'invalid', error: 'performanceIncluded must be a boolean' };
  if (!data.performanceIncluded && hasOwn(data, 'performance')) {
    return { type: 'invalid', error: 'performance must be omitted unless performanceIncluded is true' };
  }
  return { type: 'ok', included: data.performanceIncluded };
};

const parsePerformanceRecords = (value: unknown): { type: 'ok'; records: PerformanceTelemetryRecord[] } | { type: 'invalid'; index: number; error: string } => {
  if (!Array.isArray(value)) return { type: 'invalid', index: -1, error: 'performance must be an array when included' };

  const records: PerformanceTelemetryRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== 'object') return { type: 'invalid', index: i, error: 'record is not an object' };

    const item = record as Record<string, unknown>;
    if (
      typeof item.hour !== 'string' ||
      !SEARCH_USAGE_HOUR_PATTERN.test(item.hour) ||
      !isPerformanceMetricScope(item.metricScope) ||
      typeof item.keyId !== 'string' ||
      item.keyId.length === 0 ||
      typeof item.model !== 'string' ||
      item.model.length === 0 ||
      (item.upstream !== null && typeof item.upstream !== 'string') ||
      (typeof item.upstream === 'string' && isLegacyUpstreamIdentity(item.upstream)) ||
      typeof item.modelKey !== 'string' ||
      item.modelKey.length === 0 ||
      typeof item.stream !== 'boolean' ||
      typeof item.runtimeLocation !== 'string' ||
      item.runtimeLocation.length === 0 ||
      !isNonNegativeSafeInteger(item.requests) ||
      !isNonNegativeSafeInteger(item.errors) ||
      !isNonNegativeSafeInteger(item.totalMsSum) ||
      !Array.isArray(item.buckets)
    ) {
      return { type: 'invalid', index: i, error: 'record fields are missing or malformed' };
    }

    const buckets = [];
    for (const bucket of item.buckets) {
      if (!bucket || typeof bucket !== 'object') return { type: 'invalid', index: i, error: 'bucket is not an object' };
      const bucketItem = bucket as Record<string, unknown>;
      if (!isNonNegativeSafeInteger(bucketItem.lowerMs) || !isNonNegativeSafeInteger(bucketItem.upperMs) || !isNonNegativeSafeInteger(bucketItem.count) || bucketItem.upperMs <= bucketItem.lowerMs) {
        return { type: 'invalid', index: i, error: 'bucket lowerMs/upperMs/count fields are missing or malformed' };
      }
      buckets.push({ lowerMs: bucketItem.lowerMs, upperMs: bucketItem.upperMs, count: bucketItem.count });
    }

    records.push({
      hour: item.hour,
      metricScope: item.metricScope,
      keyId: item.keyId,
      model: item.model,
      upstream: item.upstream,
      modelKey: item.modelKey,
      stream: item.stream,
      runtimeLocation: item.runtimeLocation,
      requests: item.requests,
      errors: item.errors,
      totalMsSum: item.totalMsSum,
      buckets,
    });
  }

  return { type: 'ok', records };
};

// Synchronously populate the SWR models cache for each saved upstream so the
// dashboard's next navigation lands on a populated row. In merge mode the
// upstreams.save above is an ON CONFLICT UPDATE that does not touch the
// models_cache row through any FK cascade, so without this call a re-import
// that changes an upstream's config would keep serving the prior cached
// model list until SWR's soft window expired. Replace mode wiped the table
// before the loop; warming there is a no-op population. Per-upstream warm
// failures (network blip, dead credential among many) must not abort the
// import — the cache layer persists `lastError` on the row for the dashboard
// to surface. Provider-instance and fetcher construction errors signal
// genuine misconfiguration and are not swallowed.
const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<void> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const instance = await createProviderInstance(record);
  const fetcher = (await createPerRequestFetcher(getCurrentColo(c.req.raw)))(record.id);
  try {
    await fetchUpstreamModelsCached(instance, { scheduler, fetcher, force: true });
  } catch {}
};

export const exportData = async (c: CtxWithQuery<typeof exportQuery>) => {
  const repo = getRepo();
  const includePerformance = c.req.valid('query').include_performance === '1';

  const [users, apiKeys, usage, searchUsage, performance, rawSearchConfig, upstreams, proxies] = await Promise.all([
    repo.users.listIncludingDeleted(),
    repo.apiKeys.listIncludingDeleted(),
    repo.usage.listAll(),
    repo.searchUsage.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.searchConfig.get(),
    repo.upstreams.list(),
    repo.proxies.list(),
  ]);

  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      users,
      apiKeys,
      upstreams: upstreams.map(upstreamRecordToFullJson),
      proxies: proxies.map(p => ({ id: p.id, name: p.name, url: p.url, dial_timeout_seconds: p.dialTimeoutSeconds })),
      usage,
      searchUsage,
      performanceIncluded: includePerformance,
      searchConfig: rawSearchConfig === null ? parseSearchConfigDefault() : parseSearchConfigStrict(rawSearchConfig),
    },
  };
  if (includePerformance) payload.data.performance = performance;

  return c.json(payload);
};

export const importData = async (c: CtxWithJson<typeof importBody>) => {
  const body = c.req.valid('json');
  const { mode, data } = body;

  if (!isRecord(data)) return c.json({ error: 'data is required' }, 400);

  const apiKeysResult = parseApiKeyRecords(data.apiKeys);
  if (apiKeysResult.type === 'invalid') {
    const location = apiKeysResult.index >= 0 ? ` at index ${apiKeysResult.index}` : '';
    return c.json({ error: `invalid apiKeys${location}: ${apiKeysResult.error}` }, 400);
  }
  const apiKeys = apiKeysResult.records;

  const usersResult = parseUserRecords(data.users);
  if (usersResult.type === 'invalid') {
    const location = usersResult.index >= 0 ? ` at index ${usersResult.index}` : '';
    return c.json({ error: `invalid users${location}: ${usersResult.error}` }, 400);
  }
  const users = usersResult.records;
  if (!users.some(u => u.id === 1)) {
    return c.json({ error: 'invalid users: payload must include user 1 (the seed admin)' }, 400);
  }
  const known = new Set(users.map(u => u.id));
  for (let i = 0; i < apiKeys.length; i++) {
    if (!known.has(apiKeys[i].userId)) {
      return c.json({ error: `invalid apiKeys at index ${i}: user_id ${apiKeys[i].userId} does not match any user in the payload` }, 400);
    }
  }

  const usageResult = parseUsageRecords(data.usage);
  if (usageResult.type === 'invalid') {
    const location = usageResult.index >= 0 ? ` at index ${usageResult.index}` : '';
    return c.json({ error: `invalid usage${location}: ${usageResult.error}` }, 400);
  }
  const usage = usageResult.records;

  const upstreamsResult = parseUpstreamRecords(data.upstreams);
  if (upstreamsResult.type === 'invalid') {
    const location = upstreamsResult.index >= 0 ? ` at index ${upstreamsResult.index}` : '';
    return c.json({ error: `invalid upstreams${location}: ${upstreamsResult.error}` }, 400);
  }
  const upstreams = upstreamsResult.records;

  const proxiesResult = parseProxyRecords(data.proxies);
  if (proxiesResult.type === 'invalid') {
    const location = proxiesResult.index >= 0 ? ` at index ${proxiesResult.index}` : '';
    return c.json({ error: `invalid proxies${location}: ${proxiesResult.error}` }, 400);
  }
  const proxies = proxiesResult.records;

  const proxyIdentityError = validateProxyIdentities(proxies);
  if (proxyIdentityError) return c.json({ error: `invalid proxies: ${proxyIdentityError}` }, 400);

  const searchUsageResult = parseSearchUsageRecords(data.searchUsage);
  if (searchUsageResult.type === 'invalid') {
    const location = searchUsageResult.index >= 0 ? ` at index ${searchUsageResult.index}` : '';
    return c.json({ error: `invalid searchUsage${location}: ${searchUsageResult.error}` }, 400);
  }
  const searchUsage = searchUsageResult.records;

  const searchConfigResult = parseSearchConfig(data.searchConfig);
  if (searchConfigResult.type === 'invalid') {
    return c.json({ error: `invalid searchConfig: ${searchConfigResult.error}` }, 400);
  }
  const searchConfig = searchConfigResult.config;

  const performanceIncludedResult = parsePerformanceIncluded(data);
  if (performanceIncludedResult.type === 'invalid') {
    return c.json({ error: performanceIncludedResult.error }, 400);
  }
  const performanceIncluded = performanceIncludedResult.included;
  const performanceResult = performanceIncluded ? parsePerformanceRecords(data.performance) : { type: 'ok' as const, records: [] };
  if (performanceResult.type === 'invalid') {
    return c.json({ error: performanceResult.index >= 0 ? `invalid performance record at index ${performanceResult.index}: ${performanceResult.error}` : `invalid performance: ${performanceResult.error}` }, 400);
  }
  const performance = performanceResult.records;

  const repo = getRepo();
  // Snapshot pre-import key state once and reuse it for identity validation
  // and the dump-purge transitions below. Replace mode also needs to purge
  // each pre-existing key's dumps (otherwise the new owner of a reused id
  // silently inherits the old owner's captures); merge mode needs the prior
  // `dumpRetentionSeconds` per key id so a retention shrink/disable in the
  // imported payload triggers the same purge transition `updateKey` would.
  const preImportKeys = await repo.apiKeys.listIncludingDeleted();
  const preImportRetentionById = new Map<string, number | null>(preImportKeys.map(k => [k.id, k.dumpRetentionSeconds]));
  const apiKeyIdentityError = validateApiKeyIdentities(apiKeys, mode === 'merge' ? preImportKeys : [], mode);
  if (apiKeyIdentityError) return c.json({ error: `invalid apiKeys: ${apiKeyIdentityError}` }, 400);

  // In merge mode an imported upstream's proxy_fallback_list may reference an
  // existing local proxy alongside an imported one; replace mode wipes the
  // table first, so only the imported ids count.
  const existingProxyIdsForRefs = mode === 'merge' ? (await repo.proxies.list()).map(p => p.id) : [];
  const fallbackRefError = validateProxyFallbackReferences(upstreams, proxies, existingProxyIdsForRefs);
  if (fallbackRefError) return c.json({ error: `invalid upstreams: ${fallbackRefError}` }, 400);

  if (mode === 'replace') {
    // Wipe each existing key's dump capture before the replace deletes wave so
    // a reused id in the imported payload cannot inherit the previous owner's
    // captures, and any live SSE subscriber is told the key went away.
    for (const k of preImportKeys) {
      await getDumpStore().purgeAll(k.id);
      await notifyDisabledBestEffort(k.id, 'replace-mode import');
    }

    // Replace mode is intentionally non-atomic across repos: D1 binding does not expose multi-repo
    // transactions, and a coordinated batch would require every repo to surface its writes as
    // prepared statements. A failure between the deleteAll wave and the per-record save loop
    // leaves the deployment partially wiped. Operators should back up before running replace mode.
    const deletes: Promise<unknown>[] = [
      repo.sessions.deleteAll(),
      repo.apiKeys.deleteAll(),
      repo.usage.deleteAll(),
      repo.searchUsage.deleteAll(),
      repo.upstreams.deleteAll(),
      repo.proxies.deleteAll(),
      // proxy_upstream_backoffs is per-deployment runtime state keyed on
      // proxy_id; replace mode wipes the proxies table, so leaving the
      // backoff rows behind would cool-down freshly imported proxies that
      // happen to reuse a deleted id. Same intent as wiping sessions.
      repo.proxyBackoffs.deleteAll(),
      repo.responsesSnapshots.deleteAll(),
      repo.responsesItems.deleteAll(),
      repo.users.deleteAll(),
    ];
    if (performanceIncluded) deletes.push(repo.performance.deleteAll());
    await Promise.all(deletes);
  }

  // Users land before api keys so the FK from api_keys.user_id can resolve.
  // Proxies land before upstreams so any concurrent reader (e.g. a request
  // resolving an upstream's fallback list) sees the row referenced by an
  // upstream's proxy_fallback_list as soon as the upstream is visible.
  for (const user of users) await repo.users.save(user);
  for (const proxy of proxies) {
    await repo.proxies.save({
      id: proxy.id,
      name: proxy.name,
      url: proxy.url,
      dialTimeoutSeconds: proxy.dial_timeout_seconds,
    });
  }
  for (const key of apiKeys) {
    // Merge mode mirrors `updateKey`'s purge transition when retention is
    // flipped off or shrunk; replace mode already purged everything above.
    const previous = preImportRetentionById.get(key.id) ?? null;
    await repo.apiKeys.save(key);
    if (mode === 'merge' && previous !== key.dumpRetentionSeconds) {
      if (key.dumpRetentionSeconds === null && previous !== null) {
        await getDumpStore().purgeAll(key.id);
        await notifyDisabledBestEffort(key.id, 'merge-mode retention disable');
      } else if (previous !== null && key.dumpRetentionSeconds !== null && key.dumpRetentionSeconds < previous) {
        await getDumpStore().purgeExpired(key.id, key.dumpRetentionSeconds);
      }
    }
  }
  for (const record of usage) await repo.usage.set(record);
  for (const record of searchUsage) await repo.searchUsage.set(record);
  for (const upstream of upstreams) await repo.upstreams.save(upstream);
  await Promise.all(upstreams.map(upstream => warmModelsCache(upstream, c)));
  for (const record of performance) await repo.performance.set(record);
  await repo.searchConfig.save(searchConfig);

  return c.json({
    ok: true,
    imported: {
      users: users.length,
      apiKeys: apiKeys.length,
      upstreams: upstreams.length,
      proxies: proxies.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      performance: performance.length,
    },
  });
};
