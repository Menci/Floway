import { BILLING_METRICS, MODEL_KINDS, RERANK_PROTOCOLS, parseNonNegativeDecimalString } from '@floway-dev/protocols/common';
import type { ModelPrefixConfig, ProxyFallbackEntry, UpstreamModelsCache } from '@floway-dev/provider';
import { OPTIONAL_FLAG_IDS } from '@floway-dev/provider/flags';
import { z } from 'zod';

import { decodeStoredJson } from './stored-json.ts';

const opaqueJsonSchema = z.json();
const endpointSchema = z.object({}).passthrough();
const endpointsSchema = z.object({
  completions: endpointSchema.optional(),
  chatCompletions: endpointSchema.optional(),
  responses: endpointSchema.optional(),
  messages: endpointSchema.optional(),
  embeddings: endpointSchema.optional(),
  imagesGenerations: endpointSchema.optional(),
  imagesEdits: endpointSchema.optional(),
  audioTranscriptions: endpointSchema.optional(),
  rerank: endpointSchema.optional(),
}).passthrough();

const limitsSchema = z.object({
  max_output_tokens: z.number().optional(),
  max_context_window_tokens: z.number().optional(),
  max_prompt_tokens: z.number().optional(),
}).passthrough();

const chatSchema = z.object({
  modalities: z.object({
    input: z.array(z.enum(['text', 'image'])),
    output: z.array(z.enum(['text', 'image'])),
  }).passthrough().optional(),
  reasoning: z.object({
    effort: z.object({ supported: z.array(z.string()), default: z.string() }).passthrough().optional(),
    budget_tokens: z.object({ min: z.number().optional(), max: z.number().optional() }).passthrough().optional(),
    adaptive: z.boolean().optional(),
    mandatory: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

const pricingCoordinateSchema = z.union([
  z.string(),
  z.object({ operator: z.enum(['gt', 'gte']), value: z.number() }).passthrough(),
]);
const decimalStringSchema = z.string().transform((value, ctx) => {
  try {
    return parseNonNegativeDecimalString(value, 'stored model price');
  } catch (cause) {
    ctx.issues.push({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause), input: value });
    return z.NEVER;
  }
});
const pricingSchema = z.object({
  entries: z.array(z.object({
    selector: z.record(z.string(), pricingCoordinateSchema).optional(),
    rates: z.partialRecord(z.enum(BILLING_METRICS), decimalStringSchema),
  }).passthrough()),
}).passthrough();

const flagOverridesSchema = z.partialRecord(z.enum(OPTIONAL_FLAG_IDS), z.boolean());
const providerModelSchema = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  owned_by: z.string().optional(),
  created: z.number().optional(),
  limits: limitsSchema,
  kind: z.enum(MODEL_KINDS),
  pricing: pricingSchema.optional(),
  chat: chatSchema.optional(),
  endpoints: endpointsSchema,
  providerData: opaqueJsonSchema.optional(),
  rerankTarget: z.object({
    protocol: z.enum(RERANK_PROTOCOLS),
    path: z.string().optional(),
  }).passthrough().optional(),
  enabledFlags: z.array(z.enum(OPTIONAL_FLAG_IDS)).transform(flags => new Set(flags)),
  flagOverrides: flagOverridesSchema.optional(),
}).passthrough();

const modelsCacheSchema = z.object({
  revision: z.number(),
  fetchedAt: z.number(),
  models: z.array(providerModelSchema),
  lastError: z.object({ message: z.string(), at: z.number() }).passthrough().nullable(),
}).passthrough();

const flagOverridesRecordSchema = z.record(z.string(), z.boolean());
const disabledPublicModelIdsSchema = z.array(z.string());
const proxyFallbackListSchema = z.array(z.object({
  id: z.string(),
  colos: z.array(z.string()).optional(),
}));
const modelPrefixSchema = z.object({
  prefix: z.string(),
  addressable: z.array(z.enum(['unprefixed', 'prefixed'])),
  listed: z.array(z.enum(['unprefixed', 'prefixed'])),
});

const decodeUpstreamJson = <T>(raw: string, schema: z.ZodType<T>, field: string, id: string): T =>
  decodeStoredJson(raw, schema, {
    malformed: `Malformed upstream ${field} for ${id}`,
    invalid: `Invalid upstream ${field} for ${id}`,
  });

export const decodeUpstreamConfig = (raw: string, id: string): unknown =>
  decodeUpstreamJson(raw, opaqueJsonSchema, 'config JSON', id);

export const decodeUpstreamState = (raw: string, id: string): unknown =>
  decodeUpstreamJson(raw, opaqueJsonSchema, 'state JSON', id);

export const decodeUpstreamModelsCache = (raw: string, id: string): UpstreamModelsCache =>
  decodeUpstreamJson(raw, modelsCacheSchema, 'models cache JSON', id);

export const decodeUpstreamFlagOverrides = (raw: string, id: string): Record<string, boolean> =>
  decodeUpstreamJson(raw, flagOverridesRecordSchema, 'flag_overrides JSON', id);

export const decodeDisabledPublicModelIds = (raw: string, id: string): string[] =>
  decodeUpstreamJson(raw, disabledPublicModelIdsSchema, 'disabled_public_model_ids JSON', id);

export const decodeProxyFallbackList = (raw: string, id: string): ProxyFallbackEntry[] =>
  decodeUpstreamJson(raw, proxyFallbackListSchema, 'proxy_fallback_list_json', id);

export const decodeModelPrefix = (raw: string, id: string): ModelPrefixConfig =>
  decodeUpstreamJson(raw, modelPrefixSchema, 'model_prefix_json', id);

export const encodeUpstreamModelsCache = (cache: UpstreamModelsCache): string =>
  JSON.stringify(cache, (_key, value) => value instanceof Set ? [...value] : value);
