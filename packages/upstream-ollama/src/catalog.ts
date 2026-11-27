import { chatFromOllamaRaw } from './chat-from-raw.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOllamaCatalog, type OllamaCatalog } from './fetch-models.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type Fetcher, type FlagId, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

// Vision / tool / thinking capabilities live alongside `embedding` in the
// /api/show response. Embedding is the only one that drives a different
// kind/endpoints projection — the others are request-time signals.
const CHAT_ENDPOINTS: ModelEndpoints = { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
const EMBEDDING_ENDPOINTS: ModelEndpoints = { openaiEmbeddings: {} };
// Ollama serves decision models over the System One contract.
// https://docs.ollama.com/capabilities/decision
const DECISION_ENDPOINTS: ModelEndpoints = { decision: {} };

const finalizeOllamaModels = (
  catalog: OllamaCatalog,
  enabledFlags: ReadonlySet<FlagId>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const raw of catalog.data) {
    const endpoints = raw.capabilities.has('embedding')
      ? EMBEDDING_ENDPOINTS
      : raw.capabilities.has('decision') ? DECISION_ENDPOINTS : CHAT_ENDPOINTS;
    const limits: UpstreamModel['limits'] = {};
    if (raw.contextLength !== undefined) limits.max_context_window_tokens = raw.contextLength;
    const model: UpstreamModel = {
      id: raw.id,
      upstreamModelId: raw.id,
      owned_by: 'ollama',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      upstreamData: raw.id,
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

export const projectOllamaManualModels = (
  record: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
): UpstreamModel[] => {
  assertOllamaUpstreamRecord(record);
  return manualModels.map(model => {
    const enabledFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: UpstreamModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      upstreamData: model.upstreamModelId,
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
};

export const getOllamaModels = async (
  record: UpstreamRecord,
  fetcher: Fetcher,
  manualModels: readonly UpstreamModelConfig[] = [],
): Promise<UpstreamModel[]> => {
  const { config } = assertOllamaUpstreamRecord(record);
  const enabledFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides]);
  const catalog = await fetchOllamaCatalog(config, fetcher);
  const overriddenIds = new Set(manualModels.map(model => model.upstreamModelId));
  return [
    ...projectOllamaManualModels(record, manualModels),
    ...finalizeOllamaModels({ data: catalog.data.filter(raw => !overriddenIds.has(raw.id)) }, enabledFlags),
  ];
};
