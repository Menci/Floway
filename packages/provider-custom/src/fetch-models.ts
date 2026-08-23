// Custom-upstream /models response parser. Permissively accepts the
// OpenAI, Anthropic, and Floway supersets the `custom` provider needs to
// interoperate with:
//   1. OpenAI:       { object: 'list', data: [{ id, object?, owned_by?, created?,
//                      context_window?, max_output_tokens?,
//                      pricing?: { input?, output?, cache_create?, cache_hit? } }] }
//   2. Anthropic:    { data: [{ type: 'model', id, display_name?, created_at? }],
//                      has_more, first_id, last_id }     (no top-level `object`)
//   3. OpenAI/Anthropic superset with optional display_name, created_at,
//      limits, pricing, kind on the model and a `data` array on the container.
//
// OpenAI-compatible gateways publish model metadata at the model top level
// (shape 1) rather than in our nested shapes:
//   • `context_window` / `max_output_tokens`   → `limits` fields
//   • `pricing: { input, output, ... }`        → per-token ModelPricing
//     (dollars per million tokens; see perMillionTokenRates)
//   • `capabilities.vision` / `reasoning`      → `chat` modalities / effort
// A model is admitted if it has a string `id`; everything else is best-effort
// metadata. The container is admitted if `data` is an array.

import type { CustomUpstreamConfig } from './config.ts';
import { customFetchModels } from './fetch.ts';
import { BILLING_METRICS, canonicalizePricingSelector, perMillionTokenRates, type BillingMetric, type ModelKind, type ModelPricing, parseNonNegativeDecimalString, type PriceVector, type PricingSelector, validateModelPricing } from '@floway-dev/protocols/common';
import { chatField, fetchUpstreamModels, type Fetcher, type UpstreamChatModelConfig, identityWrapUpstreamCall } from '@floway-dev/provider';

export interface CustomRawModel {
  id: string;
  // OpenAI uses `created` (unix seconds). Anthropic uses `created_at`
  // (ISO-8601). We carry both and let the projection step decide.
  created?: number;
  created_at?: string;
  display_name?: string;
  // Non-standard OpenAI-compat alternative for the display name.
  name?: string;
  owned_by?: string;
  // Optional superset fields, absent on minimal OpenAI-compat upstreams.
  limits?: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  pricing?: ModelPricing;
  // Optional ModelKind published by Floway-shaped upstreams; absent on plain
  // OpenAI-compat upstreams.
  kind?: ModelKind;
  // Optional chat metadata from Floway-shaped upstreams; absent on plain
  // OpenAI-compat upstreams.
  chat?: UpstreamChatModelConfig;
}

export interface CustomModelsResponse {
  data: CustomRawModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const parseLimits = (value: unknown): CustomRawModel['limits'] => {
  if (!isRecord(value)) return undefined;
  const limits: NonNullable<CustomRawModel['limits']> = {};
  const max_output_tokens = optionalNumberField(value.max_output_tokens);
  if (max_output_tokens !== undefined) limits.max_output_tokens = max_output_tokens;
  const max_context_window_tokens = optionalNumberField(value.max_context_window_tokens);
  if (max_context_window_tokens !== undefined) limits.max_context_window_tokens = max_context_window_tokens;
  const max_prompt_tokens = optionalNumberField(value.max_prompt_tokens);
  if (max_prompt_tokens !== undefined) limits.max_prompt_tokens = max_prompt_tokens;
  return Object.keys(limits).length > 0 ? limits : undefined;
};

// Flat OpenAI-compatible pricing block published in dollars per million tokens,
// as documented for gateway-style upstreams at
// https://hyper.charm.land/docs/api/list-models.html (`pricing`).
const FLAT_PRICING_METRICS: Readonly<Record<string, BillingMetric>> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache_create: 'input_cache_write_tokens',
  cache_hit: 'input_cache_read_tokens',
};

const parseFlatPricing = (value: Record<string, unknown>): ModelPricing | undefined => {
  try {
    if (Object.keys(value).some(key => !(key in FLAT_PRICING_METRICS))) return undefined;
    const published: PriceVector = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
      published[FLAT_PRICING_METRICS[key]!] = parseNonNegativeDecimalString(String(raw), `flat pricing ${key}`);
    }
    if (Object.keys(published).length === 0) return undefined;
    const pricing: ModelPricing = { entries: [{ rates: perMillionTokenRates(published) }] };
    validateModelPricing(pricing);
    return pricing;
  } catch {
    return undefined;
  }
};

const parsePricing = (value: unknown): ModelPricing | undefined => {
  // Pricing is best-effort catalog metadata: malformed pricing omits only the pricing
  // block, never the enclosing model or the rest of the catalog.
  if (!isRecord(value)) return undefined;
  if ('entries' in value) return parseEntryPricing(value);
  return parseFlatPricing(value);
};

const parseEntryPricing = (value: Record<string, unknown>): ModelPricing | undefined => {
  try {
    if (Object.keys(value).some(key => key !== 'entries')) throw new TypeError('Malformed pricing block');
    if (!Array.isArray(value.entries)) throw new TypeError('Malformed pricing block');
    const entries: ModelPricing['entries'][number][] = [];
    for (const rawEntry of value.entries) {
      if (!isRecord(rawEntry) || !isRecord(rawEntry.rates)) throw new TypeError('Malformed pricing entry');
      if (Object.keys(rawEntry).some(key => key !== 'selector' && key !== 'rates')) throw new TypeError('Malformed pricing entry');
      if (Object.keys(rawEntry.rates).some(key => !BILLING_METRICS.includes(key as BillingMetric))) throw new TypeError('Malformed pricing rates');
      const rates: PriceVector = {};
      for (const metric of BILLING_METRICS) {
        const rawRate = rawEntry.rates[metric];
        if (rawRate === undefined) continue;
        rates[metric] = parseNonNegativeDecimalString(rawRate, `pricing rate ${metric}`);
      }
      if (Object.keys(rates).length === 0) throw new TypeError('Pricing entry has no recognized rates');
      if (rawEntry.selector !== undefined && !isRecord(rawEntry.selector)) throw new TypeError('Malformed pricing selector');
      const selector = canonicalizePricingSelector(rawEntry.selector as PricingSelector | undefined);
      entries.push({ ...(Object.keys(selector).length > 0 ? { selector } : {}), rates });
    }
    if (entries.length === 0) return undefined;
    const pricing = { entries };
    validateModelPricing(pricing);
    return pricing;
  } catch {
    return undefined;
  }
};

const parseKind = (value: unknown): ModelKind | undefined => {
  if (value === 'chat' || value === 'embedding' || value === 'image' || value === 'rerank' || value === 'transcription') return value;
  return undefined;
};

// OpenAI-compatible top-level chat metadata: `capabilities.vision` turns on
// image input, and `reasoning.effort_levels` / `reasoning.default_effort_level`
// (a `[{value, display}]` list with one display string per level) project onto
// our unified chat `effort` shape. Best-effort: anything malformed contributes
// nothing rather than dropping the model.
const parseOpenAICompatReasoningEffort = (reasoning: Record<string, unknown>): UpstreamChatModelConfig['reasoning'] | undefined => {
  try {
    if (!Array.isArray(reasoning.effort_levels) || reasoning.effort_levels.length === 0) return undefined;
    const supported: string[] = [];
    for (const raw of reasoning.effort_levels) {
      if (!isRecord(raw) || typeof raw.value !== 'string' || raw.value === '') return undefined;
      if (!supported.includes(raw.value)) supported.push(raw.value);
    }
    if (typeof reasoning.default_effort_level !== 'string' || !supported.includes(reasoning.default_effort_level)) return undefined;
    return { effort: { supported, default: reasoning.default_effort_level } };
  } catch {
    return undefined;
  }
};

const parseOpenAICompatChat = (value: Record<string, unknown>): UpstreamChatModelConfig | undefined => {
  const out: UpstreamChatModelConfig = {};
  if (isRecord(value.capabilities) && value.capabilities.vision === true) {
    out.modalities = { input: ['text', 'image'], output: ['text'] };
  }
  if (isRecord(value.reasoning)) {
    const reasoning = parseOpenAICompatReasoningEffort(value.reasoning);
    if (reasoning !== undefined) out.reasoning = reasoning;
  }
  return out.modalities === undefined && out.reasoning === undefined ? undefined : out;
};

// Explicit Floway-shaped `chat` metadata wins per-field; OpenAI-compat
// top-level derivation fills whatever the explicit block leaves out.
const mergeChat = (explicit: UpstreamChatModelConfig | undefined, derived: UpstreamChatModelConfig | undefined): UpstreamChatModelConfig | undefined => {
  if (explicit === undefined) return derived;
  if (derived === undefined) return explicit;
  const out: UpstreamChatModelConfig = {};
  if (explicit.modalities !== undefined) out.modalities = explicit.modalities;
  else if (derived.modalities !== undefined) out.modalities = derived.modalities;
  if (explicit.reasoning !== undefined || derived.reasoning !== undefined) {
    out.reasoning = { ...derived.reasoning, ...explicit.reasoning };
  }
  return out.modalities === undefined && out.reasoning === undefined ? undefined : out;
};

const parseRawModel = (value: unknown): CustomRawModel | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  const model: CustomRawModel = { id: value.id };
  const created = optionalNumberField(value.created);
  if (created !== undefined) model.created = created;
  const created_at = optionalStringField(value.created_at);
  if (created_at !== undefined) model.created_at = created_at;
  const display_name = optionalStringField(value.display_name);
  if (display_name !== undefined) model.display_name = display_name;
  const name = optionalStringField(value.name);
  if (name !== undefined) model.name = name;
  const owned_by = optionalStringField(value.owned_by);
  if (owned_by !== undefined) model.owned_by = owned_by;
  // OpenAI-compat gateways publish context_window / max_output_tokens at the
  // model top level instead of inside a `limits` object; the nested limits
  // (Floway superset) win when both are present.
  const limits = parseLimits(value.limits) ?? {};
  const context_window = optionalNumberField(value.context_window);
  if (context_window !== undefined && limits.max_context_window_tokens === undefined) limits.max_context_window_tokens = context_window;
  const max_output_tokens = optionalNumberField(value.max_output_tokens);
  if (max_output_tokens !== undefined && limits.max_output_tokens === undefined) limits.max_output_tokens = max_output_tokens;
  if (Object.keys(limits).length > 0) model.limits = limits;
  const pricing = parsePricing(value.pricing);
  if (pricing !== undefined) model.pricing = pricing;
  const kind = parseKind(value.kind);
  if (kind !== undefined) model.kind = kind;
  // Attempt to parse chat metadata; silently skip on malformed data.
  try {
    const explicit = chatField(value.chat, `${value.id}.chat`);
    model.chat = mergeChat(explicit, parseOpenAICompatChat(value));
  } catch { /* skip */ }
  return model;
};

const parseCustomModelsResponse = (value: unknown): CustomModelsResponse | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const data: CustomRawModel[] = [];
  for (const item of value.data) {
    const model = parseRawModel(item);
    if (model) data.push(model);
  }
  return { data };
};

export const fetchCustomModels = (config: CustomUpstreamConfig, fetcher: Fetcher): Promise<CustomModelsResponse> =>
  fetchUpstreamModels(
    () => customFetchModels(config, { method: 'GET' }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    parseCustomModelsResponse,
  );
