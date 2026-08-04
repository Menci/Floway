import { z } from 'zod';

import { parseWebSearchConfigStrict } from '../../data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { parseDisabledPublicModelIdsWire } from '../../repo/disabled-public-models.ts';
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { isResponsesRetentionSeconds, RESPONSES_RETENTION_MAX_SECONDS, RESPONSES_RETENTION_MIN_SECONDS } from '../../repo/responses-retention.ts';
import { SEED_ADMIN_USER_ID } from '../../repo/seed-admin.ts';
import type { ApiKey, PerformanceMetric, PerformanceTelemetryRecord, UsageRecord, User, WebSearchUsageRecord } from '../../repo/types.ts';
import { PASSWORD_HASH_SCHEME } from '../../shared/passwords.ts';
import { RETENTION_MAX_SECONDS } from '../../shared/retention.ts';
import { parseServerSecret } from '../../shared/server-secret.ts';
import { isWebSearchProviderName } from '../../shared/web-search-providers.ts';
import { USERNAME_PATTERN } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { parseUpstreamIdsValue } from '../shared/upstream-ids.ts';
import { BILLING_METRICS, canonicalizePricingSelector, type BillingMetric, parseNonNegativeDecimalString, type PricingSelector } from '@floway-dev/protocols/common';
import { ALL_PROVIDER_KINDS, normalizeModelPrefix, normalizeUpstreamHue, parseFlagOverridesWire, parsePerformanceOperation, type ProxyFallbackEntry, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import { assertClaudeCodeUpstreamRecord, assertClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { assertCodexUpstreamRecord, assertCodexUpstreamState } from '@floway-dev/provider-codex';
import { parseCopilotUpstreamConfig } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord } from '@floway-dev/provider-ollama';
import { parseProxyUri } from '@floway-dev/proxy';

export interface SerializedProxy {
  id: string;
  name: string;
  url: string;
  dial_timeout_seconds: number | null;
}

export interface ParsedImportData {
  users: User[];
  apiKeys: ApiKey[];
  upstreams: UpstreamRecord[];
  proxies: SerializedProxy[];
  usage: UsageRecord[];
  searchUsage: WebSearchUsageRecord[];
  performance: PerformanceTelemetryRecord[];
  performanceIncluded: boolean;
  searchConfig: WebSearchConfig;
}

export type ImportDataParseResult = { type: 'ok'; data: ParsedImportData } | { type: 'invalid'; error: string };

const SEARCH_USAGE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const LEGACY_UPSTREAM_PREFIXES = ['openai:', 'copilot:'];
const PERFORMANCE_METRICS = ['ttft_ms', 'tpot_us'] as const satisfies readonly PerformanceMetric[];

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isLegacyUpstreamIdentity = (value: string): boolean => LEGACY_UPSTREAM_PREFIXES.some(prefix => value.startsWith(prefix));
const messageFor = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const addIssue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: 'custom', message });

const parsedBy = <T>(parser: (value: unknown) => T) => z.unknown().transform((value, ctx): T => {
  try {
    return parser(value);
  } catch (cause) {
    addIssue(ctx, messageFor(cause));
    return z.NEVER;
  }
});

const nonEmptyStringSchema = (field: string) => z.string({ error: `${field} must be a non-empty string` })
  .min(1, { error: `${field} must be a non-empty string` });
const nonEmptyStringWithError = (message: string) => z.string({ error: message }).min(1, { error: message });
const nullableStringSchema = (field: string) => z.union([
  z.string(),
  z.null(),
], { error: `${field} must be null or an ISO string` });
const positiveIntegerSchema = (field: string) => z.number({ error: `${field} must be a positive integer` })
  .int({ error: `${field} must be a positive integer` })
  .positive({ error: `${field} must be a positive integer` });
const nonNegativeSafeIntegerSchema = (message: string) => z.number({ error: message })
  .int({ error: message })
  .nonnegative({ error: message })
  .max(Number.MAX_SAFE_INTEGER, { error: message });

const upstreamIdsSchema = parsedBy(value => {
  const result = parseUpstreamIdsValue(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
});

const proxyFallbackEntrySchema = z.object({
  id: z.string({ error: 'proxy_fallback_list entry .id must be a string' }),
  colos: z.array(z.string({ error: 'proxy_fallback_list entry .colos members must be strings' }), {
    error: 'proxy_fallback_list entry .colos must be an array',
  }).optional(),
}, { error: 'proxy_fallback_list entries must be objects' });

const proxyFallbackListSchema = z.array(proxyFallbackEntrySchema, { error: 'proxy_fallback_list must be an array' })
  .optional()
  .transform((value): ProxyFallbackEntry[] => normalizeProxyFallbackList(value ?? []));

const normalizeUpstreamConfig = (record: UpstreamRecord): unknown => {
  switch (record.kind) {
  case 'custom': return assertCustomUpstreamRecord(record).config;
  case 'azure': return assertAzureUpstreamRecord(record).config;
  case 'ollama': return assertOllamaUpstreamRecord(record).config;
  case 'codex':
    assertCodexUpstreamRecord(record);
    return record.config;
  case 'claude-code':
    assertClaudeCodeUpstreamRecord(record);
    return record.config;
  case 'copilot': return parseCopilotUpstreamConfig(record.config, (field, expected) => new Error(`${field} must be ${expected}`));
  }
};

const normalizeUpstreamState = (kind: UpstreamProviderKind, value: unknown): unknown => {
  if (kind !== 'codex' && kind !== 'claude-code') return null;
  if (value === null || value === undefined) throw new Error(`${kind} upstream is missing state — re-export with current code`);
  if (kind === 'codex') assertCodexUpstreamState(value);
  else assertClaudeCodeUpstreamState(value);
  return value;
};

const upstreamWireShapeSchema = z.object({
  id: nonEmptyStringSchema('id'),
  kind: z.enum(ALL_PROVIDER_KINDS, { error: `kind must be one of ${ALL_PROVIDER_KINDS.join(', ')}` }),
  name: nonEmptyStringSchema('name'),
  enabled: z.boolean({ error: 'enabled must be a boolean' }),
  sort_order: z.number({ error: 'sort_order must be a finite number' })
    .finite({ error: 'sort_order must be a finite number' }),
  created_at: nonEmptyStringSchema('created_at'),
  updated_at: nonEmptyStringSchema('updated_at'),
  flag_overrides: parsedBy(parseFlagOverridesWire),
  disabled_public_model_ids: parsedBy(parseDisabledPublicModelIdsWire),
  proxy_fallback_list: proxyFallbackListSchema,
  model_prefix: parsedBy(normalizeModelPrefix),
  hue: parsedBy(normalizeUpstreamHue),
  config: z.unknown(),
  state: z.unknown().optional(),
}).superRefine((wire, ctx) => {
  if (isLegacyUpstreamIdentity(wire.id)) {
    addIssue(ctx, 'id must use a raw upstream id, not a legacy provider-prefixed identity');
  }
}).transform((wire, ctx): UpstreamRecord => {
  try {
    const record: UpstreamRecord = {
      id: wire.id,
      kind: wire.kind,
      name: wire.name,
      enabled: wire.enabled,
      sortOrder: Math.floor(wire.sort_order),
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
      flagOverrides: wire.flag_overrides,
      disabledPublicModelIds: wire.disabled_public_model_ids,
      proxyFallbackList: wire.proxy_fallback_list,
      modelPrefix: wire.model_prefix,
      hue: wire.hue,
      config: wire.config,
      state: normalizeUpstreamState(wire.kind, wire.state),
      modelsCache: null,
    };
    return { ...record, config: normalizeUpstreamConfig(record) };
  } catch (cause) {
    addIssue(ctx, messageFor(cause));
    return z.NEVER;
  }
});

const upstreamWireSchema = z.unknown().transform((value, ctx) => {
  if (isRecord(value) && hasOwn(value, 'enabled_fixes')) {
    addIssue(ctx, "legacy 'enabled_fixes' field is no longer supported; re-export with current code");
    return z.NEVER;
  }
  return value;
}).pipe(upstreamWireShapeSchema);

const proxySchema = z.object({
  id: nonEmptyStringSchema('id').refine(id => !isDirectFallbackId(id), {
    error: 'id must not be a reserved direct-transport sentinel',
  }),
  name: nonEmptyStringSchema('name'),
  url: nonEmptyStringSchema('url').transform((url, ctx) => {
    try {
      parseProxyUri(url);
      return url;
    } catch (cause) {
      addIssue(ctx, `url did not parse: ${messageFor(cause)}`);
      return z.NEVER;
    }
  }),
  dial_timeout_seconds: z.union([
    positiveIntegerSchema('dial_timeout_seconds'),
    z.null(),
  ], { error: 'dial_timeout_seconds must be null or a positive integer' }),
});

const dumpRetentionSchema = parsedBy((value): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > RETENTION_MAX_SECONDS) {
    throw new Error(`dumpRetentionSeconds must be null or a positive integer up to ${RETENTION_MAX_SECONDS}`);
  }
  return value;
});
const responsesRetentionSchema = parsedBy((value): number => {
  if (!isResponsesRetentionSeconds(value)) {
    throw new Error(`responsesRetentionSeconds must be 0 or a whole-day integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS}`);
  }
  return value;
});

const apiKeySchema = z.object({
  id: nonEmptyStringSchema('id'),
  userId: positiveIntegerSchema('userId'),
  name: nonEmptyStringSchema('name'),
  key: nonEmptyStringSchema('key'),
  serverSecret: parsedBy(parseServerSecret),
  createdAt: nonEmptyStringSchema('createdAt'),
  lastUsedAt: nonEmptyStringSchema('lastUsedAt').optional(),
  upstreamIds: upstreamIdsSchema,
  deletedAt: nullableStringSchema('deletedAt'),
  dumpRetentionSeconds: dumpRetentionSchema,
  responsesRetentionSeconds: responsesRetentionSchema,
});

const userSchema = z.object({
  id: positiveIntegerSchema('id'),
  username: z.string({ error: 'username must match ^[a-zA-Z0-9_.-]{1,64}$' })
    .regex(USERNAME_PATTERN, { error: 'username must match ^[a-zA-Z0-9_.-]{1,64}$' }),
  passwordHash: z.union([
    z.string().refine(value => value.startsWith(`${PASSWORD_HASH_SCHEME}$`), {
      error: `passwordHash must be null or start with ${PASSWORD_HASH_SCHEME}$`,
    }),
    z.null(),
  ], { error: `passwordHash must be null or start with ${PASSWORD_HASH_SCHEME}$` }),
  isAdmin: z.boolean({ error: 'isAdmin must be a boolean' }),
  upstreamIds: parsedBy(value => {
    if (value === undefined) throw new Error('upstreamIds must be present (null or array)');
    const result = parseUpstreamIdsValue(value);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }),
  createdAt: nonEmptyStringSchema('createdAt'),
  deletedAt: nullableStringSchema('deletedAt'),
});

const sequentialArraySchema = <T>(
  schema: z.ZodType<T>,
  arrayError: string,
  validateRecord?: (record: T, index: number, prior: readonly T[]) => string | null,
) => z.unknown().transform((value, ctx): T[] => {
  const array = z.array(z.unknown(), { error: arrayError }).safeParse(value);
  if (!array.success) {
    addIssue(ctx, array.error.issues[0].message);
    return z.NEVER;
  }

  const records: T[] = [];
  for (let index = 0; index < array.data.length; index++) {
    const result = schema.safeParse(array.data[index]);
    if (!result.success) {
      addIssue(ctx, result.error.issues[0].message);
      return z.NEVER;
    }
    const validationError = validateRecord?.(result.data, index, records);
    if (validationError) {
      addIssue(ctx, validationError);
      return z.NEVER;
    }
    records.push(result.data);
  }
  return records;
});

const metricSchema = z.object({
  metric: z.unknown().transform((value, ctx): BillingMetric => {
    if (typeof value !== 'string' || !BILLING_METRICS.includes(value as BillingMetric)) {
      addIssue(ctx, `unknown usage metric: ${JSON.stringify(value)}`);
      return z.NEVER;
    }
    return value as BillingMetric;
  }),
  quantity: parsedBy(value => parseNonNegativeDecimalString(value, 'metric quantity')),
  unitPrice: z.unknown().transform((value, ctx): string | null => {
    if (value === null) return null;
    try {
      return parseNonNegativeDecimalString(value, 'metric unitPrice');
    } catch (cause) {
      addIssue(ctx, messageFor(cause));
      return z.NEVER;
    }
  }),
}, { error: 'metrics must contain objects' });

const metricsSchema = sequentialArraySchema(
  metricSchema,
  'metrics must be an array',
  (row, _index, prior) => prior.some(candidate => candidate.metric === row.metric)
    ? `duplicate usage metric: ${row.metric}`
    : null,
);

const invalidUsageField = 'record has invalid usage fields';
const usageSchema = z.object({
  keyId: nonEmptyStringWithError(invalidUsageField),
  model: nonEmptyStringWithError(invalidUsageField),
  upstream: z.union([z.string(), z.null()], { error: invalidUsageField }),
  modelKey: nonEmptyStringWithError(invalidUsageField),
  hour: z.string({ error: invalidUsageField }).regex(SEARCH_USAGE_HOUR_PATTERN, { error: invalidUsageField }),
  pricingSelector: z.record(z.string(), z.unknown(), { error: 'pricingSelector must be an object' }).transform((selector, ctx) => {
    try {
      return canonicalizePricingSelector(selector as PricingSelector);
    } catch (cause) {
      addIssue(ctx, `invalid pricingSelector: ${messageFor(cause)}`);
      return z.NEVER;
    }
  }),
  requests: nonNegativeSafeIntegerSchema(invalidUsageField),
  metrics: metricsSchema,
}, { error: 'record must be an object' }).superRefine((record, ctx) => {
  if (typeof record.upstream === 'string' && isLegacyUpstreamIdentity(record.upstream)) {
    addIssue(ctx, 'upstream must use a raw upstream id, not a legacy provider-prefixed identity');
  }
});

const searchUsageSchema = z.object({
  provider: z.unknown().transform((value, ctx) => {
    if (!isWebSearchProviderName(value)) {
      addIssue(ctx, 'invalid provider');
      return z.NEVER;
    }
    return value;
  }),
  keyId: nonEmptyStringSchema('keyId'),
  action: z.enum(['search', 'fetch_page'], { error: 'action must be "search" or "fetch_page"' }),
  hour: z.string({ error: 'hour must match the SEARCH_USAGE_HOUR_PATTERN' })
    .regex(SEARCH_USAGE_HOUR_PATTERN, { error: 'hour must match the SEARCH_USAGE_HOUR_PATTERN' }),
  requests: nonNegativeSafeIntegerSchema('requests must be a non-negative safe integer'),
}, { error: 'record must be an object' });

const malformedPerformance = 'record fields are missing or malformed';
const performanceInteger = nonNegativeSafeIntegerSchema(malformedPerformance);
const performanceBucketSchema = z.object({
  metric: z.enum(PERFORMANCE_METRICS, { error: 'bucket metric/lower/upper/count fields are missing or malformed' }),
  lower: nonNegativeSafeIntegerSchema('bucket metric/lower/upper/count fields are missing or malformed'),
  upper: z.union([
    nonNegativeSafeIntegerSchema('bucket metric/lower/upper/count fields are missing or malformed'),
    z.null(),
  ], { error: 'bucket metric/lower/upper/count fields are missing or malformed' }),
  count: nonNegativeSafeIntegerSchema('bucket metric/lower/upper/count fields are missing or malformed'),
}, { error: 'bucket is not an object' }).superRefine((bucket, ctx) => {
  if (bucket.upper !== null && bucket.upper <= bucket.lower) {
    addIssue(ctx, 'bucket metric/lower/upper/count fields are missing or malformed');
  }
});

const performanceBucketsSchema = sequentialArraySchema(
  performanceBucketSchema,
  malformedPerformance,
  (bucket, _index, prior) => prior.some(candidate => candidate.metric === bucket.metric && candidate.lower === bucket.lower)
    ? `duplicate bucket entry for {metric: ${bucket.metric}, lower: ${bucket.lower}}`
    : null,
);

const performanceSchema = z.object({
  hour: z.string({ error: malformedPerformance }).regex(SEARCH_USAGE_HOUR_PATTERN, { error: malformedPerformance }),
  keyId: nonEmptyStringWithError(malformedPerformance),
  model: nonEmptyStringWithError(malformedPerformance),
  upstream: nonEmptyStringWithError(malformedPerformance).refine(value => !isLegacyUpstreamIdentity(value), { error: malformedPerformance }),
  operation: parsedBy(value => {
    try {
      return parsePerformanceOperation(value);
    } catch {
      throw new Error(malformedPerformance);
    }
  }),
  runtimeLocation: nonEmptyStringWithError(malformedPerformance),
  requests: performanceInteger,
  ttftSamplesOk: performanceInteger,
  errorsWithOutput: performanceInteger,
  errorsNoOutput: performanceInteger,
  neutral: performanceInteger,
  tpotSamples: performanceInteger,
  ttftMsSum: performanceInteger,
  tpotUsSum: performanceInteger,
  buckets: performanceBucketsSchema,
}, { error: 'record is not an object' }).superRefine((record, ctx) => {
  const ttftSamples = record.ttftSamplesOk + record.errorsWithOutput;
  if (ttftSamples + record.errorsNoOutput + record.neutral !== record.requests) {
    addIssue(ctx, 'ttftSamplesOk + errorsWithOutput + errorsNoOutput + neutral must equal requests');
    return;
  }
  if (record.tpotSamples > ttftSamples) {
    addIssue(ctx, 'tpotSamples must not exceed ttftSamplesOk + errorsWithOutput');
    return;
  }

  let ttftBucketCount = 0;
  let tpotBucketCount = 0;
  for (const bucket of record.buckets) {
    if (bucket.metric === 'ttft_ms') ttftBucketCount += bucket.count;
    else tpotBucketCount += bucket.count;
  }
  if (ttftBucketCount !== ttftSamples) {
    addIssue(ctx, `ttft_ms bucket sum (${ttftBucketCount}) must equal ttftSamplesOk + errorsWithOutput (${ttftSamples})`);
  } else if (tpotBucketCount !== record.tpotSamples) {
    addIssue(ctx, `tpot_us bucket sum (${tpotBucketCount}) must equal tpotSamples (${record.tpotSamples})`);
  }
});

interface CollectionOptions<T> {
  arrayError: string;
  optional?: boolean;
  validateRecord?: (record: T, index: number, prior: readonly T[]) => string | null;
}

// Zod reports every invalid array element in one result. Imports historically
// stop at the first record, so parse each element independently after Zod owns
// the array boundary; this retains deterministic index and error precedence.
const parseCollection = <T>(
  label: string,
  schema: z.ZodType<T>,
  value: unknown,
  options: CollectionOptions<T>,
): { type: 'ok'; records: T[] } | { type: 'invalid'; error: string } => {
  if (options.optional && value === undefined) return { type: 'ok', records: [] };
  const array = z.array(z.unknown(), { error: options.arrayError }).safeParse(value);
  if (!array.success) return { type: 'invalid', error: `invalid ${label}: ${array.error.issues[0].message}` };

  const records: T[] = [];
  for (let index = 0; index < array.data.length; index++) {
    const result = schema.safeParse(array.data[index]);
    if (!result.success) {
      return { type: 'invalid', error: `invalid ${label} at index ${index}: ${result.error.issues[0].message}` };
    }
    const validationError = options.validateRecord?.(result.data, index, records);
    if (validationError) return { type: 'invalid', error: `invalid ${label} at index ${index}: ${validationError}` };
    records.push(result.data);
  }
  return { type: 'ok', records };
};

export const parseImportData = (value: unknown): ImportDataParseResult => {
  if (!isRecord(value)) return { type: 'invalid', error: 'data is required' };

  const apiKeys = parseCollection('apiKeys', apiKeySchema, value.apiKeys, { arrayError: 'apiKeys must be an array' });
  if (apiKeys.type === 'invalid') return apiKeys;
  const users = parseCollection('users', userSchema, value.users, {
    arrayError: 'users must be an array',
    validateRecord: (user, _index, prior) => prior.some(candidate => candidate.id === user.id)
      ? `duplicate user id ${user.id}`
      : null,
  });
  if (users.type === 'invalid') return users;
  if (!users.records.some(user => user.id === SEED_ADMIN_USER_ID)) {
    return { type: 'invalid', error: 'invalid users: payload must include user 1 (the seed admin)' };
  }
  const userIds = new Set(users.records.map(user => user.id));
  for (let index = 0; index < apiKeys.records.length; index++) {
    if (!userIds.has(apiKeys.records[index].userId)) {
      return { type: 'invalid', error: `invalid apiKeys at index ${index}: user_id ${apiKeys.records[index].userId} does not match any user in the payload` };
    }
  }

  const usage = parseCollection('usage', usageSchema, value.usage, { arrayError: 'usage must be an array' });
  if (usage.type === 'invalid') return usage;
  const upstreams = parseCollection('upstreams', upstreamWireSchema, value.upstreams, { arrayError: 'upstreams must be an array' });
  if (upstreams.type === 'invalid') return upstreams;
  const proxies = parseCollection('proxies', proxySchema, value.proxies, { arrayError: 'proxies must be an array', optional: true });
  if (proxies.type === 'invalid') return proxies;
  const proxyIds = new Map<string, number>();
  for (let index = 0; index < proxies.records.length; index++) {
    const prior = proxyIds.get(proxies.records[index].id);
    if (prior !== undefined) {
      return { type: 'invalid', error: `invalid proxies: duplicate proxies id ${proxies.records[index].id} at indexes ${prior} and ${index}` };
    }
    proxyIds.set(proxies.records[index].id, index);
  }

  const searchUsage = parseCollection('searchUsage', searchUsageSchema, value.searchUsage, { arrayError: 'searchUsage must be an array' });
  if (searchUsage.type === 'invalid') return searchUsage;

  let searchConfig: WebSearchConfig;
  try {
    searchConfig = parseWebSearchConfigStrict(value.searchConfig);
  } catch (cause) {
    return { type: 'invalid', error: `invalid searchConfig: ${messageFor(cause)}` };
  }

  if (typeof value.performanceIncluded !== 'boolean') {
    return { type: 'invalid', error: 'performanceIncluded must be a boolean' };
  }
  if (!value.performanceIncluded && hasOwn(value, 'performance')) {
    return { type: 'invalid', error: 'performance must be omitted unless performanceIncluded is true' };
  }
  let performance: PerformanceTelemetryRecord[] = [];
  if (value.performanceIncluded) {
    const parsed = parseCollection('performance', performanceSchema, value.performance, { arrayError: 'performance must be an array when included' });
    if (parsed.type === 'invalid') {
      return { type: 'invalid', error: parsed.error.replace(/^invalid performance at index /, 'invalid performance record at index ') };
    }
    performance = parsed.records;
  }

  return {
    type: 'ok',
    data: {
      users: users.records,
      apiKeys: apiKeys.records,
      upstreams: upstreams.records,
      proxies: proxies.records,
      usage: usage.records,
      searchUsage: searchUsage.records,
      performance,
      performanceIncluded: value.performanceIncluded,
      searchConfig,
    },
  };
};
