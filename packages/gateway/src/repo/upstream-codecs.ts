import { z } from 'zod';

import {
  decodeStoredJson,
  decodeStoredJsonValue,
  parseStoredJson,
  preserveDecodedStoredJsonProperties,
} from './stored-json.ts';
import { BILLING_METRICS, DECISION_PROTOCOLS, MODEL_KINDS, RERANK_PROTOCOLS, parseNonNegativeDecimalString } from '@floway-dev/protocols/common';
import type { ProviderModel, ProxyFallbackEntry, UpstreamModelConfig } from '@floway-dev/provider';
import { OPTIONAL_FLAG_IDS } from '@floway-dev/provider/flags';

// JSON.parse already establishes the JSON grammar. This schema exists to keep
// the repository boundary explicit without reconstructing objects and losing
// unusual-but-valid own keys such as `__proto__`.
const opaqueJsonSchema = z.unknown().refine(value => value !== undefined, 'stored JSON cannot be undefined');
const endpointSchema = z.object({}).passthrough();
const endpointsSchema = z.object({
  openaiCompletions: endpointSchema.exactOptional(),
  openaiChatCompletions: endpointSchema.exactOptional(),
  openaiResponses: endpointSchema.exactOptional(),
  anthropicMessages: endpointSchema.exactOptional(),
  geminiGenerateContent: endpointSchema.exactOptional(),
  openaiEmbeddings: endpointSchema.exactOptional(),
  openaiImagesGenerations: endpointSchema.exactOptional(),
  openaiImagesEdits: endpointSchema.exactOptional(),
  openaiAudioTranscriptions: endpointSchema.exactOptional(),
  rerank: endpointSchema.exactOptional(),
  decision: endpointSchema.exactOptional(),
}).passthrough();

const limitsSchema = z.object({
  max_output_tokens: z.number().exactOptional(),
  max_context_window_tokens: z.number().exactOptional(),
  max_prompt_tokens: z.number().exactOptional(),
}).passthrough();

const chatSchema = z.object({
  modalities: z.object({
    input: z.array(z.enum(['text', 'image', 'audio'])),
    output: z.array(z.enum(['text', 'image'])),
  }).passthrough().exactOptional(),
  image_detail_original: z.boolean().exactOptional(),
  reasoning: z.object({
    effort: z.object({ supported: z.array(z.string()), default: z.string() }).passthrough().exactOptional(),
    budget_tokens: z.object({ min: z.number().exactOptional(), max: z.number().exactOptional() }).passthrough().exactOptional(),
    adaptive: z.boolean().exactOptional(),
    mandatory: z.boolean().exactOptional(),
  }).passthrough().exactOptional(),
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
    selector: z.record(z.string(), pricingCoordinateSchema).exactOptional(),
    rates: z.partialRecord(z.enum(BILLING_METRICS), decimalStringSchema),
  }).passthrough()),
}).passthrough();

const flagOverridesSchema = z.partialRecord(z.enum(OPTIONAL_FLAG_IDS), z.boolean());
const opaqueBlobCompatibilityScopeSchema = z.object({
  bindToUpstream: z.boolean(),
  key: z.string().min(1).exactOptional(),
}).strict();

const providerModelSchema = z.object({
  id: z.string(),
  upstreamModelId: z.string(),
  display_name: z.string().exactOptional(),
  owned_by: z.string().exactOptional(),
  created: z.number().exactOptional(),
  limits: limitsSchema,
  kind: z.enum(MODEL_KINDS),
  pricing: pricingSchema.exactOptional(),
  chat: chatSchema.exactOptional(),
  endpoints: endpointsSchema,
  opaqueBlobCompatibilityScope: opaqueBlobCompatibilityScopeSchema,
  providerData: opaqueJsonSchema.exactOptional(),
  rerankTarget: z.object({
    protocol: z.enum(RERANK_PROTOCOLS),
    path: z.string().exactOptional(),
  }).passthrough().exactOptional(),
  decisionTarget: z.object({
    protocol: z.enum(DECISION_PROTOCOLS),
    path: z.string().exactOptional(),
  }).passthrough().exactOptional(),
  enabledFlags: z.array(z.enum(OPTIONAL_FLAG_IDS)).transform(flags => new Set(flags)),
  flagOverrides: flagOverridesSchema.exactOptional(),
}).passthrough();

const upstreamModelConfigSchema = z.object({
  upstreamModelId: z.string(),
  publicModelId: z.string().exactOptional(),
  display_name: z.string().exactOptional(),
  limits: limitsSchema.exactOptional(),
  kind: z.enum(MODEL_KINDS),
  pricing: pricingSchema.exactOptional(),
  chat: chatSchema.exactOptional(),
  endpoints: endpointsSchema,
  opaqueBlobCompatibilityScope: opaqueBlobCompatibilityScopeSchema.exactOptional(),
  rerankTarget: z.object({
    protocol: z.enum(RERANK_PROTOCOLS),
    path: z.string().exactOptional(),
  }).passthrough().exactOptional(),
  decisionTarget: z.object({
    protocol: z.enum(DECISION_PROTOCOLS),
    path: z.string().exactOptional(),
  }).passthrough().exactOptional(),
  flagOverrides: flagOverridesSchema.exactOptional(),
}).passthrough();

const flagOverridesRecordSchema = z.record(z.string(), z.boolean());
const disabledPublicModelIdsSchema = z.array(z.string());
const proxyFallbackListSchema = z.array(z.object({
  id: z.string(),
  colos: z.array(z.string()).exactOptional(),
}));

const decodeUpstreamJson = <T>(raw: string, schema: z.ZodType<T>, field: string, id: string): T =>
  decodeStoredJson(raw, schema, {
    malformed: `Malformed upstream ${field} for ${id}`,
    invalid: `Invalid upstream ${field} for ${id}`,
  });

export const decodeUpstreamConfig = (raw: string, id: string): unknown =>
  decodeUpstreamJson(raw, opaqueJsonSchema, 'config JSON', id);

export const decodeUpstreamState = (raw: string, id: string): unknown =>
  decodeUpstreamJson(raw, opaqueJsonSchema, 'state JSON', id);

export const decodeUpstreamModel = (raw: string, upstreamId: string): ProviderModel => {
  const messages = {
    malformed: `Malformed upstream model JSON for ${upstreamId}`,
    invalid: `Invalid upstream model JSON for ${upstreamId}`,
  };
  const parsed = parseStoredJson(raw, messages.malformed);
  return preserveDecodedStoredJsonProperties(
    parsed,
    decodeStoredJsonValue(parsed, providerModelSchema, messages.invalid),
  );
};

export const encodeUpstreamModel = (model: ProviderModel): string =>
  JSON.stringify(model, (_key, value) => value instanceof Set ? [...value] : value);

export const decodeUpstreamManualModel = (raw: string, upstreamId: string): UpstreamModelConfig => {
  const messages = {
    malformed: `Malformed upstream manual model JSON for ${upstreamId}`,
    invalid: `Invalid upstream manual model JSON for ${upstreamId}`,
  };
  const parsed = parseStoredJson(raw, messages.malformed);
  return preserveDecodedStoredJsonProperties(
    parsed,
    decodeStoredJsonValue(parsed, upstreamModelConfigSchema, messages.invalid),
  );
};

export const encodeUpstreamManualModel = (model: UpstreamModelConfig): string =>
  JSON.stringify(model);

export const decodeUpstreamFlagOverrides = (raw: string, id: string): Record<string, boolean> =>
  decodeUpstreamJson(raw, flagOverridesRecordSchema, 'flag_overrides JSON', id);

export const decodeDisabledPublicModelIds = (raw: string, id: string): string[] =>
  decodeUpstreamJson(raw, disabledPublicModelIdsSchema, 'disabled_public_model_ids JSON', id);

export const decodeProxyFallbackList = (raw: string, id: string): ProxyFallbackEntry[] =>
  decodeUpstreamJson(raw, proxyFallbackListSchema, 'proxy_fallback_list_json', id);
