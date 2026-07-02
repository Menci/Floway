import { isKnownFlagId } from './flags.ts';
import { BILLING_DIMENSIONS, type BillingDimension, type ChatModelInfo, type ModelEndpointKey, type ModelEndpoints, type ModelKind, type Modality, type ModelPricing } from '@floway-dev/protocols/common';
import { kindForEndpoints } from '@floway-dev/protocols/common';

export type { Modality } from '@floway-dev/protocols/common';

export interface UpstreamModelLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface UpstreamModelFlagOverrides {
  enabled: boolean;
  values: Record<string, boolean>;
}

// The catalog-side name for the wire chat metadata. Shape lives in
// @floway-dev/protocols/common so PublicModel.chat and the upstream catalog
// share a single declaration.
export type UpstreamChatModelConfig = ChatModelInfo;

export interface UpstreamModelConfig {
  // Mirrors of fields that flow through to PublicModel (snake_case for parity).
  kind: ModelKind;
  endpoints: ModelEndpoints;
  display_name?: string;
  limits?: UpstreamModelLimits;
  cost?: ModelPricing;
  chat?: UpstreamChatModelConfig;
  // Floway-internal (camelCase, not surfaced on PublicModel).
  upstreamModelId: string;
  publicModelId?: string;
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
      // An empty overlay is a valid declaration: the tier exists but every
      // dimension inherits base pricing. Preserve it verbatim.
      tiers[tierName] = tierPricing;
    }
    if (Object.keys(tiers).length > 0) pricing.tiers = tiers;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
};

const MODEL_KINDS: ReadonlySet<ModelKind> = new Set<ModelKind>(['chat', 'embedding', 'image']);

const MODALITY_VALUES: ReadonlySet<Modality> = new Set<Modality>(['text', 'image']);

const modalityArrayField = (value: unknown, label: string): readonly Modality[] => {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}: must be an array`);
  const out: Modality[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !MODALITY_VALUES.has(entry as Modality)) {
      throw new Error(`Malformed ${label}: unknown modality ${JSON.stringify(entry)}`);
    }
    if (!out.includes(entry as Modality)) out.push(entry as Modality);
  }
  if (out.length === 0) throw new Error(`Malformed ${label}: must have at least one modality`);
  return out;
};

const inputModalitiesField = (value: unknown, label: string): readonly Modality[] => {
  const modalities = modalityArrayField(value, label);
  if (!modalities.includes('text')) throw new Error(`Malformed ${label}: must include 'text'`);
  return modalities;
};

const optionalNonNegativeIntField = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Malformed ${label}: must be a non-negative integer`);
  }
  return value;
};

const reasoningField = (value: unknown, label: string): UpstreamChatModelConfig['reasoning'] => {
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);

  const result: NonNullable<UpstreamChatModelConfig['reasoning']> = {};

  if (value.effort !== undefined) {
    if (!isRecord(value.effort)) throw new Error(`Malformed ${label}.effort: must be an object`);
    if (!Array.isArray(value.effort.supported)) throw new Error(`Malformed ${label}.effort.supported: must be an array`);
    const supported: string[] = [];
    for (const eff of value.effort.supported) {
      if (typeof eff !== 'string' || eff.length === 0) throw new Error(`Malformed ${label}.effort.supported: every entry must be a non-empty string`);
      if (!supported.includes(eff)) supported.push(eff);
    }
    if (supported.length === 0) throw new Error(`Malformed ${label}.effort.supported: must have at least one entry`);
    if (typeof value.effort.default !== 'string' || value.effort.default.length === 0) {
      throw new Error(`Malformed ${label}.effort.default: must be a non-empty string`);
    }
    if (!supported.includes(value.effort.default)) {
      throw new Error(`Malformed ${label}.effort.default: ${JSON.stringify(value.effort.default)} not in effort.supported`);
    }
    result.effort = { supported, default: value.effort.default };
  }

  if (value.budget_tokens !== undefined) {
    if (!isRecord(value.budget_tokens)) throw new Error(`Malformed ${label}.budget_tokens: must be an object`);
    const min = optionalNonNegativeIntField(value.budget_tokens.min, `${label}.budget_tokens.min`);
    const max = optionalNonNegativeIntField(value.budget_tokens.max, `${label}.budget_tokens.max`);
    if (min !== undefined && max !== undefined && max < min) {
      throw new Error(`Malformed ${label}.budget_tokens: max must be >= min`);
    }
    result.budget_tokens = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }

  if (value.adaptive !== undefined) {
    if (typeof value.adaptive !== 'boolean') throw new Error(`Malformed ${label}.adaptive: must be a boolean`);
    // Strip false — semantically equivalent to absent.
    if (value.adaptive) result.adaptive = true;
  }

  if (value.mandatory !== undefined) {
    if (typeof value.mandatory !== 'boolean') throw new Error(`Malformed ${label}.mandatory: must be a boolean`);
    // Strip false — semantically equivalent to absent.
    if (value.mandatory) result.mandatory = true;
  }

  if (result.effort === undefined && result.budget_tokens === undefined && result.adaptive === undefined && result.mandatory === undefined) {
    throw new Error(`Malformed ${label}: must have at least one of effort, budget_tokens, adaptive, mandatory`);
  }

  return result;
};

export const chatField = (value: unknown, label: string): UpstreamChatModelConfig | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  const out: UpstreamChatModelConfig = {};
  if (value.modalities !== undefined) {
    if (!isRecord(value.modalities)) throw new Error(`Malformed ${label}.modalities: must be an object`);
    out.modalities = {
      input: inputModalitiesField(value.modalities.input, `${label}.modalities.input`),
      output: modalityArrayField(value.modalities.output, `${label}.modalities.output`),
    };
  }
  if (value.reasoning !== undefined) out.reasoning = reasoningField(value.reasoning, `${label}.reasoning`);
  if (out.modalities === undefined && out.reasoning === undefined) return undefined;
  return out;
};

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
  const kind = kindField(value.kind, endpoints, `${label}.kind`);
  const chat = chatField(value.chat, `${label}.chat`);
  if (chat !== undefined && kind !== 'chat') {
    throw new Error(`Malformed ${label}: chat field is only allowed when kind === 'chat'`);
  }
  return {
    kind,
    endpoints,
    ...(value.display_name !== undefined ? { display_name: optionalStringField(value.display_name, `${label}.display_name`) } : {}),
    ...(value.limits !== undefined ? { limits: limitsField(value.limits, `${label}.limits`) } : {}),
    ...(cost ? { cost } : {}),
    ...(chat ? { chat } : {}),
    upstreamModelId: nonEmptyStringField(value.upstreamModelId, `${label}.upstreamModelId`),
    ...(value.publicModelId !== undefined ? { publicModelId: optionalStringField(value.publicModelId, `${label}.publicModelId`) } : {}),
    ...(value.flagOverrides !== undefined ? { flagOverrides: flagOverridesField(value.flagOverrides, `${label}.flagOverrides`) } : {}),
  };
};

export const modelsField = (value: unknown, providerLabel: string): UpstreamModelConfig[] => {
  if (!Array.isArray(value)) throw new Error(`Malformed ${providerLabel} upstream config: models must be an array`);
  return value.map((entry, i) => modelField(entry, `${providerLabel} models[${i}]`));
};
