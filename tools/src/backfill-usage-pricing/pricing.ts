import { ToolError } from './errors.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { canonicalPricingSelectorKey, type ModelPricing, type PriceVector, validateModelPricing } from '@floway-dev/protocols/common';
import { assertUpstreamProviderKind, isRecord, modelsField, pricingField, type UpstreamModelConfig, type UpstreamProviderKind } from '@floway-dev/provider';
import { pricingForClaudeCodeModelKey } from '@floway-dev/provider-claude-code';
import { pricingForCodexModelKey } from '@floway-dev/provider-codex';
import { pricingForCopilotPublicModelId } from '@floway-dev/provider-copilot';
import { pricingForOllamaModelKey } from '@floway-dev/provider-ollama';

const CATALOG_HARD_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredUpstream {
  id: string;
  provider: string;
  configJson: string;
  modelsCacheJson: string | null;
}

export type PricingResolution =
  | { status: 'priced'; pricing: ModelPricing; source: string; guardsModelsCache: boolean }
  | { status: 'unpriced'; source: string; guardsModelsCache: boolean }
  | { status: 'unavailable'; reason: string };

const parsedJson = (raw: string, label: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ToolError('stored-json', `${label} is malformed`, 1, { cause });
  }
};

const configuredModels = (upstream: StoredUpstream): UpstreamModelConfig[] => {
  const config = parsedJson(upstream.configJson, `Upstream ${upstream.id} config_json`);
  if (!isRecord(config) || config.models === undefined) return [];
  return modelsField(config.models, `${upstream.provider} upstream ${upstream.id}`);
};

const configuredModel = (upstream: StoredUpstream, modelKey: string): UpstreamModelConfig | undefined =>
  configuredModels(upstream).find(model => model.upstreamModelId === modelKey);

const customModelsFetchEnabled = (upstream: StoredUpstream): boolean => {
  const config = parsedJson(upstream.configJson, `Upstream ${upstream.id} config_json`);
  if (!isRecord(config) || config.modelsFetch === undefined) return true;
  if (!isRecord(config.modelsFetch) || typeof config.modelsFetch.enabled !== 'boolean') {
    throw new ToolError('custom-models-fetch', `Custom upstream ${upstream.id} has malformed modelsFetch config`, 1);
  }
  return config.modelsFetch.enabled;
};

const staticResolution = (pricing: ModelPricing | null, source: string): PricingResolution =>
  pricing === null
    ? { status: 'unpriced', source, guardsModelsCache: false }
    : { status: 'priced', pricing, source, guardsModelsCache: false };

const customCacheResolution = (
  upstream: StoredUpstream,
  model: string,
  modelKey: string,
  now: number,
): PricingResolution => {
  if (upstream.modelsCacheJson === null) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} has no stored model catalog` };
  }
  const cache = parsedJson(upstream.modelsCacheJson, `Upstream ${upstream.id} models_cache_json`);
  if (!isRecord(cache) || cache.revision !== MODEL_CATALOG_REVISION || typeof cache.fetchedAt !== 'number' || !Array.isArray(cache.models)) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} has no current stored model catalog` };
  }
  if (!Number.isFinite(cache.fetchedAt) || now - cache.fetchedAt >= CATALOG_HARD_TTL_MS) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} model catalog is older than 24 hours` };
  }
  const cached = cache.models.find(candidate =>
    isRecord(candidate) && candidate.id === model && candidate.providerData === modelKey);
  if (!isRecord(cached)) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} catalog does not contain ${model} (${modelKey})` };
  }
  const pricing = pricingField(cached.pricing, `custom upstream ${upstream.id} cached model ${model}.pricing`);
  return pricing === undefined
    ? { status: 'unpriced', source: `upstream:${upstream.id}:models-cache`, guardsModelsCache: true }
    : { status: 'priced', pricing, source: `upstream:${upstream.id}:models-cache`, guardsModelsCache: true };
};

export const resolveUsagePricing = (
  upstream: StoredUpstream,
  identity: { model: string; modelKey: string },
  now = Date.now(),
): PricingResolution => {
  const provider: UpstreamProviderKind = assertUpstreamProviderKind(upstream.provider);
  const manual = configuredModel(upstream, identity.modelKey);
  switch (provider) {
  case 'azure':
    if (manual === undefined) return { status: 'unavailable', reason: `Azure config no longer contains model key ${identity.modelKey}` };
    return staticResolution(manual.pricing ?? null, `upstream:${upstream.id}:config`);
  case 'custom':
    if (manual?.pricing !== undefined) return staticResolution(manual.pricing, `upstream:${upstream.id}:config`);
    if (!customModelsFetchEnabled(upstream)) {
      return manual === undefined
        ? { status: 'unavailable', reason: `Custom config no longer contains model key ${identity.modelKey}` }
        : { status: 'unpriced', source: `upstream:${upstream.id}:config`, guardsModelsCache: false };
    }
    return customCacheResolution(upstream, identity.model, identity.modelKey, now);
  case 'ollama':
    if (manual?.pricing !== undefined) return staticResolution(manual.pricing, `upstream:${upstream.id}:config`);
    return staticResolution(pricingForOllamaModelKey(identity.modelKey), 'provider:ollama');
  case 'copilot':
    return staticResolution(pricingForCopilotPublicModelId(identity.model), 'provider:copilot');
  case 'codex':
    return staticResolution(pricingForCodexModelKey(identity.modelKey), 'provider:codex');
  case 'claude-code':
    return staticResolution(pricingForClaudeCodeModelKey(identity.modelKey), 'provider:claude-code');
  default:
    provider satisfies never;
    throw new Error(`Unhandled provider: ${provider as string}`);
  }
};

export const ratesForStoredSelector = (
  pricing: ModelPricing,
  selectorKey: string,
): { exact: boolean; rates: PriceVector | null } => {
  validateModelPricing(pricing);
  const exact = pricing.entries.find(entry => canonicalPricingSelectorKey(entry.selector) === selectorKey);
  if (exact !== undefined) return { exact: true, rates: exact.rates };
  const base = pricing.entries.find(entry => canonicalPricingSelectorKey(entry.selector) === '{}');
  return { exact: false, rates: base?.rates ?? null };
};
