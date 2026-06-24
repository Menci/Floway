import { isKnownFlagId } from './flags.ts';
import { BILLING_DIMENSIONS, type BillingDimension, type ModelEndpointKey, type ModelEndpoints, type ModelKind, type ModelPricing } from '@floway-dev/protocols/common';
import { kindForEndpoints } from '@floway-dev/protocols/common';

export interface UpstreamModelLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface UpstreamModelFlagOverrides {
  enabled: boolean;
  values: Record<string, boolean>;
}

export interface UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId?: string;
  // Required metadata mirroring our public model definition. Routing is driven
  // by `endpoints` (the structured capability map: a present key means the model
  // is served by that endpoint); `kind` decides which fields the dashboard form
  // surfaces and is derived from `endpoints` when an entry omits it.
  kind: ModelKind;
  endpoints: ModelEndpoints;
  display_name?: string;
  limits?: UpstreamModelLimits;
  cost?: ModelPricing;
  flagOverrides?: UpstreamModelFlagOverrides;
}

// The public catalog id a model is exposed under: an explicit override when set,
// otherwise the upstream id itself.
export const publicModelId = (model: UpstreamModelConfig): string => {
  const configured = model.publicModelId?.trim();
  return configured && configured.length > 0 ? configured : model.upstreamModelId;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const nonEmptyStringField = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed ${label}: must be a non-empty string`);
  return value;
};

export const optionalStringField = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Malformed ${label}: must be a string`);
  return value;
};

const MODEL_ENDPOINT_KEYS: ReadonlySet<ModelEndpointKey> = new Set<ModelEndpointKey>([
  'completions', 'chatCompletions', 'responses', 'messages', 'embeddings', 'imagesGenerations', 'imagesEdits',
]);

// The structured per-model capability map. A present key declares the model is
// served by that endpoint; the empty value object is a placeholder reserved
// for future per-endpoint sub-capabilities. `allowEmpty` is set for the
// upstream-level fallback map (an upstream may serve only kind-derived
// embedding/image models and declare no chat endpoint).
export const endpointsField = (value: unknown, label: string, options: { allowEmpty?: boolean } = {}): ModelEndpoints => {
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  const endpoints: ModelEndpoints = {};
  for (const [key, sub] of Object.entries(value)) {
    if (!MODEL_ENDPOINT_KEYS.has(key as ModelEndpointKey)) throw new Error(`Malformed ${label}: unsupported endpoint ${key}`);
    if (!isRecord(sub)) throw new Error(`Malformed ${label}.${key}: must be an object`);
    endpoints[key as ModelEndpointKey] = {};
  }
  if (!options.allowEmpty && Object.keys(endpoints).length === 0) throw new Error(`Malformed ${label}: must declare at least one endpoint`);
  return endpoints;
};

const optionalNumberField = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Malformed ${label}: must be a finite number`);
  return value;
};

const optionalMetadataRecord = (value: unknown, label: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  return value;
};

export const limitsField = (value: unknown, label: string): UpstreamModelLimits | undefined => {
  const record = optionalMetadataRecord(value, label);
  if (!record) return undefined;
  return {
    ...(record.max_context_window_tokens !== undefined ? { max_context_window_tokens: optionalNumberField(record.max_context_window_tokens, `${label}.max_context_window_tokens`) } : {}),
    ...(record.max_prompt_tokens !== undefined ? { max_prompt_tokens: optionalNumberField(record.max_prompt_tokens, `${label}.max_prompt_tokens`) } : {}),
    ...(record.max_output_tokens !== undefined ? { max_output_tokens: optionalNumberField(record.max_output_tokens, `${label}.max_output_tokens`) } : {}),
  };
};

export const flagOverridesField = (value: unknown, label: string): UpstreamModelFlagOverrides | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  if (typeof value.enabled !== 'boolean') throw new Error(`Malformed ${label}.enabled: must be a boolean`);
  if (!isRecord(value.values)) throw new Error(`Malformed ${label}.values: must be an object`);
  const unknown: string[] = [];
  const values: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(value.values)) {
    if (typeof on !== 'boolean') throw new Error(`Malformed ${label}.values.${id}: must be a boolean`);
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    values[id] = on;
  }
  if (unknown.length > 0) {
    throw new Error(`Malformed ${label}.values: unknown flag ids: ${unknown.join(', ')}`);
  }
  return { enabled: value.enabled, values };
};

const nonNegativeNumberField = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Malformed ${label}: must be a finite non-negative number`);
  }
  return value;
};

export const pricingField = (value: unknown, label: string): ModelPricing | undefined => {
  const record = optionalMetadataRecord(value, label);
  if (!record) return undefined;
  const pricing: ModelPricing = {};
  for (const dimension of BILLING_DIMENSIONS) {
    if (record[dimension] !== undefined) pricing[dimension] = nonNegativeNumberField(record[dimension], `${label}.${dimension}`);
  }
  if (record.tiers !== undefined) {
    if (!isRecord(record.tiers)) throw new Error(`Malformed ${label}.tiers: must be an object`);
    const tiers: Record<string, Partial<Record<BillingDimension, number>>> = {};
    for (const [tierName, overlay] of Object.entries(record.tiers)) {
      if (tierName === '') throw new Error(`Malformed ${label}.tiers: tier name must be non-empty`);
      if (!isRecord(overlay)) throw new Error(`Malformed ${label}.tiers.${tierName}: must be an object`);
      const tierPricing: Partial<Record<BillingDimension, number>> = {};
      for (const dimension of BILLING_DIMENSIONS) {
        if (overlay[dimension] !== undefined) {
          tierPricing[dimension] = nonNegativeNumberField(overlay[dimension], `${label}.tiers.${tierName}.${dimension}`);
        }
      }
      if (Object.keys(tierPricing).length > 0) tiers[tierName] = tierPricing;
    }
    if (Object.keys(tiers).length > 0) pricing.tiers = tiers;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
};

const MODEL_KINDS: ReadonlySet<ModelKind> = new Set<ModelKind>(['chat', 'embedding', 'image']);

// kind is a pure function of the routing endpoints, so an entry that omits it
// (an import, or hand-edited JSON) derives one rather than failing. The editor
// always writes an explicit kind, keeping it consistent with the endpoints.
const kindField = (value: unknown, endpoints: ModelEndpoints, label: string): ModelKind => {
  if (value === undefined) return kindForEndpoints(endpoints);
  if (typeof value !== 'string' || !MODEL_KINDS.has(value as ModelKind)) {
    throw new Error(`Malformed ${label}: must be one of chat, embedding, image`);
  }
  return value as ModelKind;
};

const modelField = (value: unknown, label: string): UpstreamModelConfig => {
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  const cost = pricingField(value.cost, `${label}.cost`);
  const endpoints = endpointsField(value.endpoints, `${label}.endpoints`);
  return {
    upstreamModelId: nonEmptyStringField(value.upstreamModelId, `${label}.upstreamModelId`),
    ...(value.publicModelId !== undefined ? { publicModelId: optionalStringField(value.publicModelId, `${label}.publicModelId`) } : {}),
    kind: kindField(value.kind, endpoints, `${label}.kind`),
    endpoints,
    ...(value.display_name !== undefined ? { display_name: optionalStringField(value.display_name, `${label}.display_name`) } : {}),
    ...(value.limits !== undefined ? { limits: limitsField(value.limits, `${label}.limits`) } : {}),
    ...(cost ? { cost } : {}),
    ...(value.flagOverrides !== undefined ? { flagOverrides: flagOverridesField(value.flagOverrides, `${label}.flagOverrides`) } : {}),
  };
};

export const modelsField = (value: unknown, providerLabel: string): UpstreamModelConfig[] => {
  if (!Array.isArray(value)) throw new Error(`Malformed ${providerLabel} upstream config: models must be an array`);
  return value.map((entry, i) => modelField(entry, `${providerLabel} models[${i}]`));
};
