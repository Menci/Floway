// Custom-upstream /models response parser. Permissively accepts the shapes our
// `custom` provider needs to interoperate with:
//   1. OpenAI:       { object: 'list', data: [{ id, object?, owned_by?, created? }] }
//   2. Anthropic:    { data: [{ type: 'model', id, display_name?, created_at? }],
//                      has_more, first_id, last_id }     (no top-level `object`)
//   3. OpenAI/Anthropic superset with optional display_name, created_at,
//      limits, pricing, kind on the model and a `data` array on the container.
//   4. Gemini:       { models: [{ name: 'models/{id}', displayName?,
//                      supportedGenerationMethods?, inputTokenLimit?,
//                      outputTokenLimit? }], nextPageToken? }
//
// A model is admitted if it has a string `id` (Gemini spells it inside
// `name`); everything else is best-effort metadata. The container is admitted
// if `data` or `models` is an array. Gemini pages its listing, so the fetch
// follows `nextPageToken` until the catalog is complete.

import type { CustomUpstreamConfig } from './config.ts';
import { customFetchModels } from './fetch.ts';
import { BILLING_METRICS, canonicalizePricingSelector, type BillingMetric, type ModelKind, type ModelPricing, type OpaqueBlobCompatibilityScope, parseNonNegativeDecimalString, type PriceVector, type PricingSelector, validateModelPricing } from '@floway-dev/protocols/common';
import { chatField, fetchUpstreamModels, type Fetcher, type UpstreamChatModelConfig, identityWrapUpstreamCall, opaqueBlobCompatibilityScopeField } from '@floway-dev/upstream';

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
  opaqueBlobCompatibilityScope?: OpaqueBlobCompatibilityScope;
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

const parsePricing = (value: unknown): ModelPricing | undefined => {
  // Pricing is best-effort catalog metadata: malformed pricing omits only the pricing
  // block, never the enclosing model or the rest of the catalog.
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  try {
    if (Object.keys(value).some(key => key !== 'entries')) throw new TypeError('Malformed pricing block');
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
  const limits = parseLimits(value.limits);
  if (limits !== undefined) model.limits = limits;
  const pricing = parsePricing(value.pricing);
  if (pricing !== undefined) model.pricing = pricing;
  const kind = parseKind(value.kind);
  if (kind !== undefined) model.kind = kind;
  // Attempt to parse chat metadata; silently skip on malformed data.
  try {
    const chat = chatField(value.chat, `${value.id}.chat`);
    if (chat !== undefined) model.chat = chat;
  } catch { /* skip */ }
  try {
    const scope = opaqueBlobCompatibilityScopeField(value.opaqueBlobCompatibilityScope, `${value.id}.opaqueBlobCompatibilityScope`);
    if (scope !== undefined) model.opaqueBlobCompatibilityScope = scope;
  } catch { /* skip */ }
  return model;
};

// Gemini's catalog names a model `models/{id}` and publishes its context
// window as separate input/output limits rather than a context size.
// https://ai.google.dev/api/models#Model
const parseGeminiModel = (value: unknown): CustomRawModel | null => {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const id = value.name.replace(/^models\//, '');
  if (id === '') return null;
  const model: CustomRawModel = { id };
  const displayName = optionalStringField(value.displayName);
  if (displayName !== undefined) model.display_name = displayName;
  const inputTokenLimit = optionalNumberField(value.inputTokenLimit);
  const outputTokenLimit = optionalNumberField(value.outputTokenLimit);
  if (inputTokenLimit !== undefined || outputTokenLimit !== undefined) {
    model.limits = {
      ...(inputTokenLimit !== undefined ? { max_prompt_tokens: inputTokenLimit, max_context_window_tokens: inputTokenLimit } : {}),
      ...(outputTokenLimit !== undefined ? { max_output_tokens: outputTokenLimit } : {}),
    };
  }
  // Only models that advertise generateContent can serve our chat routes.
  if (Array.isArray(value.supportedGenerationMethods)
    && !value.supportedGenerationMethods.includes('generateContent')) return null;
  return model;
};

interface CustomModelsPage extends CustomModelsResponse {
  nextPageToken?: string;
}

const parseCustomModelsPage = (value: unknown): CustomModelsPage | null => {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.models)) {
    const data: CustomRawModel[] = [];
    for (const item of value.models) {
      const model = parseGeminiModel(item);
      if (model) data.push(model);
    }
    // `models.list` returns 50 models per page unless asked otherwise and
    // marks a continuation with `nextPageToken`.
    // https://ai.google.dev/api/models#method:-models.list
    const nextPageToken = optionalStringField(value.nextPageToken);
    return nextPageToken === undefined ? { data } : { data, nextPageToken };
  }
  if (!Array.isArray(value.data)) return null;
  const data: CustomRawModel[] = [];
  for (const item of value.data) {
    const model = parseRawModel(item);
    if (model) data.push(model);
  }
  return { data };
};

export const fetchCustomModels = async (config: CustomUpstreamConfig, fetcher: Fetcher): Promise<CustomModelsResponse> => {
  const data: CustomRawModel[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchUpstreamModels(
      () => customFetchModels(config, { method: 'GET' }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }, pageToken),
      parseCustomModelsPage,
    );
    data.push(...page.data);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return { data };
};
