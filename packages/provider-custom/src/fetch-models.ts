// Custom-upstream /models response parser. Permissively accepts the three
// shapes our `custom` provider needs to interoperate with:
//   1. OpenAI:       { object: 'list', data: [{ id, object?, owned_by?, created? }] }
//   2. Anthropic:    { data: [{ type: 'model', id, display_name?, created_at? }],
//                      has_more, first_id, last_id }     (no top-level `object`)
//   3. OpenAI/Anthropic superset with optional display_name, created_at,
//      limits, pricing, kind on the model and a `data` array on the container.
//
// A model is admitted if it has a string `id`; everything else is best-
// effort metadata. The container is admitted if `data` is an array.
// Anthropic pages forward `last_id` as the next request's `after_id`:
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/core/pagination.ts#L115-L199

import type { CustomUpstreamConfig } from './config.ts';
import { customFetchModels } from './fetch.ts';
import { BILLING_METRICS, canonicalizePricingSelector, type BillingMetric, type ModelKind, type ModelPricing, parseNonNegativeDecimalString, type PriceVector, type PricingSelector, validateModelPricing } from '@floway-dev/protocols/common';
import { chatField, fetchUpstreamModels, type Fetcher, type UpstreamChatModelConfig, identityWrapUpstreamCall, ProviderModelsUnavailableError, runProviderModelsTask } from '@floway-dev/provider';

const MAX_CUSTOM_MODEL_PAGES = 32;
const MAX_CUSTOM_MODELS = 4096;
const MAX_CUSTOM_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;

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

interface CustomModelsPage extends CustomModelsResponse {
  modelLimitExceeded?: true;
  nextAfterId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalRepresentableUnixSeconds = (value: unknown): number | undefined => {
  const seconds = optionalNumberField(value);
  return seconds !== undefined && !Number.isNaN(new Date(seconds * 1000).getTime()) ? seconds : undefined;
};

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

const parseModelLimits = (value: Record<string, unknown>): CustomRawModel['limits'] => {
  const limits: NonNullable<CustomRawModel['limits']> = { ...(parseLimits(value.limits) ?? {}) };
  const maxInputTokens = optionalNumberField(value.max_input_tokens);
  if (maxInputTokens !== undefined) limits.max_context_window_tokens = maxInputTokens;
  const maxTokens = optionalNumberField(value.max_tokens);
  if (maxTokens !== undefined) limits.max_output_tokens = maxTokens;
  return Object.keys(limits).length > 0 ? limits : undefined;
};

const supportedCapability = (value: unknown): boolean => isRecord(value) && value.supported === true;

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/models.ts#L127-L245
const chatFromAnthropicCapabilities = (value: unknown): UpstreamChatModelConfig | undefined => {
  if (!isRecord(value)) return undefined;
  const chat: UpstreamChatModelConfig = {};
  if (supportedCapability(value.image_input)) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] };
  }

  const reasoning: NonNullable<UpstreamChatModelConfig['reasoning']> = {};
  if (isRecord(value.effort) && value.effort.supported === true) {
    const publishedLevels = Object.entries(value.effort)
      .filter(([level, capability]) => level !== 'supported' && supportedCapability(capability))
      .map(([level]) => level);
    const canonicalLevels = ['low', 'medium', 'high', 'max', 'xhigh'];
    const supported = [
      ...canonicalLevels.filter(level => publishedLevels.includes(level)),
      ...publishedLevels.filter(level => !canonicalLevels.includes(level)),
    ];
    if (supported.length > 0) {
      reasoning.effort = {
        supported,
        default: supported.includes('medium') ? 'medium' : supported[0],
      };
    }
  }
  if (isRecord(value.thinking) && isRecord(value.thinking.types)) {
    if (supportedCapability(value.thinking.types.enabled)) reasoning.budget_tokens = {};
    if (supportedCapability(value.thinking.types.adaptive)) reasoning.adaptive = true;
  }
  if (Object.keys(reasoning).length > 0) chat.reasoning = reasoning;
  return Object.keys(chat).length > 0 ? chat : undefined;
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
  const created = optionalRepresentableUnixSeconds(value.created);
  if (created !== undefined) model.created = created;
  const created_at = optionalStringField(value.created_at);
  if (created_at !== undefined) model.created_at = created_at;
  const display_name = optionalStringField(value.display_name);
  if (display_name !== undefined) model.display_name = display_name;
  const name = optionalStringField(value.name);
  if (name !== undefined) model.name = name;
  const owned_by = optionalStringField(value.owned_by);
  if (owned_by !== undefined) model.owned_by = owned_by;
  const limits = parseModelLimits(value);
  if (limits !== undefined) model.limits = limits;
  const pricing = parsePricing(value.pricing);
  if (pricing !== undefined) model.pricing = pricing;
  const kind = parseKind(value.kind);
  if (kind !== undefined) model.kind = kind;
  let chat: UpstreamChatModelConfig | undefined;
  try {
    chat = chatField(value.chat, `${value.id}.chat`);
  } catch { /* skip */ }
  chat ??= chatFromAnthropicCapabilities(value.capabilities);
  if (chat !== undefined) model.chat = chat;
  return model;
};

const parseCustomModelsPage = (value: unknown): CustomModelsPage | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  if (value.data.length > MAX_CUSTOM_MODELS) return { data: [], modelLimitExceeded: true };
  const data: CustomRawModel[] = [];
  for (const item of value.data) {
    const model = parseRawModel(item);
    if (model) data.push(model);
  }
  if (value.data.length > 0 && data.length === 0) return null;
  if (value.has_more !== undefined && typeof value.has_more !== 'boolean') return null;
  if (value.has_more === true) {
    const nextAfterId = optionalStringField(value.last_id);
    if (data.length === 0 || nextAfterId === undefined) return null;
    return { data, nextAfterId };
  }
  return { data };
};

const paginationError = (message: string): ProviderModelsUnavailableError =>
  new ProviderModelsUnavailableError(null, new Error(message));

export const fetchCustomModels = (
  config: CustomUpstreamConfig,
  fetcher: Fetcher,
  options: { idleTimeoutMs?: number; maxCatalogResponseBytes?: number; signal?: AbortSignal; totalTimeoutMs?: number } = {},
): Promise<CustomModelsResponse> => runProviderModelsTask(async signal => {
  const maxCatalogResponseBytes = options.maxCatalogResponseBytes ?? MAX_CUSTOM_CATALOG_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxCatalogResponseBytes) || maxCatalogResponseBytes <= 0) {
    throw new TypeError('maxCatalogResponseBytes must be a positive safe integer');
  }
  const data: CustomRawModel[] = [];
  const responseByteBudget = { remainingBytes: maxCatalogResponseBytes };
  const seenModelIds = new Set<string>();
  const seenCursors = new Set<string>();
  let afterId: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_CUSTOM_MODEL_PAGES; pageIndex++) {
    if (responseByteBudget.remainingBytes === 0) {
      throw paginationError('Custom /models catalog exhausted its response byte budget');
    }
    const page = await fetchUpstreamModels(
      pageSignal => customFetchModels(config, { method: 'GET', signal: pageSignal }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }, afterId),
      parseCustomModelsPage,
      { idleTimeoutMs: options.idleTimeoutMs, responseByteBudget, signal, totalTimeoutMs: options.totalTimeoutMs },
    );
    if (page.modelLimitExceeded) {
      throw paginationError(`Custom /models catalog exceeded ${MAX_CUSTOM_MODELS} models`);
    }
    for (const model of page.data) {
      if (seenModelIds.has(model.id)) continue;
      if (seenModelIds.size >= MAX_CUSTOM_MODELS) {
        throw paginationError(`Custom /models catalog exceeded ${MAX_CUSTOM_MODELS} models`);
      }
      seenModelIds.add(model.id);
      data.push(model);
    }
    if (page.nextAfterId === undefined) return { data };
    if (seenCursors.has(page.nextAfterId)) {
      throw paginationError(`Custom /models pagination repeated cursor ${JSON.stringify(page.nextAfterId)}`);
    }
    seenCursors.add(page.nextAfterId);
    afterId = page.nextAfterId;
  }

  throw paginationError(`Custom /models pagination exceeded ${MAX_CUSTOM_MODEL_PAGES} pages`);
}, options).catch((cause: unknown) => {
  if (options.signal?.aborted) throw options.signal.reason;
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  throw cause;
});
