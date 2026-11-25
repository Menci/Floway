import { chatFromOllamaRaw } from './chat-from-raw.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOllamaCatalog, type OllamaCatalog } from './fetch-models.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type Fetcher, type FlagId, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

// Ollama advertises embedding and decision capabilities in /api/show. Audio
// transcription has a route without a capability bit and is configured manually.
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
const CHAT_ENDPOINTS: ModelEndpoints = { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
const EMBEDDING_ENDPOINTS: ModelEndpoints = { openaiEmbeddings: {} };
// Ollama serves decision models over the System One contract.
// https://docs.ollama.com/capabilities/decision
const DECISION_ENDPOINTS: ModelEndpoints = { decision: {} };

const finalizeOllamaModels = (
  catalog: OllamaCatalog,
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const raw of catalog.data) {
    const endpoints = raw.capabilities.has('embedding')
      ? EMBEDDING_ENDPOINTS
      : raw.capabilities.has('decision') ? DECISION_ENDPOINTS : CHAT_ENDPOINTS;
    const limits: ProviderModel['limits'] = {};
    if (raw.contextLength !== undefined) limits.max_context_window_tokens = raw.contextLength;
    const model: ProviderModel = {
      id: raw.id,
      upstreamModelId: raw.id,
      owned_by: 'ollama',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      enabledFlags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
      ...(endpoints.decision ? { decisionTarget: { protocol: 'typesafe-systemone' as const } } : {}),
    };
    if (raw.modifiedAt !== undefined) model.created = raw.modifiedAt;
    const pricing = pricingForOllamaModelKey(raw.id);
    if (pricing) model.pricing = pricing;
    const chat = chatFromOllamaRaw(raw);
    if (chat) model.chat = chat;
    models.push(model);
  }
  return models;
};

export const getOllamaProvidedModels = async (record: UpstreamRecord, fetcher: Fetcher): Promise<ProviderModel[]> => {
  const { config } = assertOllamaUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides]);

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: ProviderModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      // Ollama serves every decision model over System One; the dialect is not
      // the operator's to choose.
      ...(kind === 'decision' ? { decisionTarget: { protocol: 'typesafe-systemone' as const } } : {}),
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    const pricing = model.pricing ?? pricingForOllamaModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
  const catalog = await fetchOllamaCatalog(config, fetcher);
  const auto = finalizeOllamaModels({ data: catalog.data.filter(raw => !overriddenIds.has(raw.id)) }, upstreamFlags);
  return [...manualModels, ...auto];
};
