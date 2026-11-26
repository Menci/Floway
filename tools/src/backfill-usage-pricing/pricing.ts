import { ToolError } from './errors.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { canonicalPricingSelectorKey, type ModelPricing, type PriceVector, validateModelPricing } from '@floway-dev/protocols/common';
import { assertUpstreamKind, isRecord, pricingField, type UpstreamModelConfig, type UpstreamKind } from '@floway-dev/upstream';
import { pricingForChatGPTModelKey } from '@floway-dev/upstream-chatgpt';
import { pricingForClaudeCodeModelKey } from '@floway-dev/upstream-claude-code';
import { pricingForCopilotPublicModelId } from '@floway-dev/upstream-copilot';
import { pricingForKimiCodePublicModelId } from '@floway-dev/upstream-kimi-code';
import { pricingForOllamaModelKey } from '@floway-dev/upstream-ollama';

const CATALOG_HARD_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredUpstream {
  id: string;
  kind: string;
  configJson: string;
  manualModels: readonly UpstreamModelConfig[];
  modelsCacheRevision: number | null;
  modelsCacheFetchedAt: number | null;
  cachedModelJson: string | null;
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

const configuredModel = (upstream: StoredUpstream, modelKey: string): UpstreamModelConfig | undefined =>
  upstream.manualModels.find(model => model.upstreamModelId === modelKey);

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
  if (upstream.modelsCacheFetchedAt === null) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} has no stored model catalog` };
  }
  if (upstream.modelsCacheRevision !== MODEL_CATALOG_REVISION) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} has no current stored model catalog` };
  }
  if (!Number.isFinite(upstream.modelsCacheFetchedAt) || now - upstream.modelsCacheFetchedAt >= CATALOG_HARD_TTL_MS) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} model catalog is older than 24 hours` };
  }
  if (upstream.cachedModelJson === null) {
    return { status: 'unavailable', reason: `Custom upstream ${upstream.id} catalog does not contain ${model} (${modelKey})` };
  }
  const cached = parsedJson(upstream.cachedModelJson, `Upstream ${upstream.id} upstream_models.model_json`);
  if (!isRecord(cached) || cached.id !== model || cached.upstreamData !== modelKey) {
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
  const kind: UpstreamKind = assertUpstreamKind(upstream.kind);
  const manual = configuredModel(upstream, identity.modelKey);
  switch (kind) {
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
    return staticResolution(pricingForOllamaModelKey(identity.modelKey), 'upstream:ollama');
  case 'kimi-code':
    return staticResolution(pricingForKimiCodePublicModelId(identity.model), 'upstream:kimi-code');
  case 'copilot':
    return staticResolution(pricingForCopilotPublicModelId(identity.model), 'upstream:copilot');
  case 'chatgpt':
    return staticResolution(pricingForChatGPTModelKey(identity.modelKey), 'upstream:chatgpt');
  case 'claude-code':
    return staticResolution(pricingForClaudeCodeModelKey(identity.modelKey), 'upstream:claude-code');
  default:
    kind satisfies never;
    throw new Error(`Unhandled upstream kind: ${kind as string}`);
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
