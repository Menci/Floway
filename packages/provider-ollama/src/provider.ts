// Ollama provider. Builds a ProviderModel catalog from /api/tags + /api/show
// (see fetch-models.ts) and routes inference through Ollama's OpenAI-/
// Anthropic-compat shims at /v1/chat/completions, /v1/responses, /v1/messages,
// /v1/completions, /v1/embeddings, /v1/audio/transcriptions — the same paths the cloud (ollama.com) and
// self-hosted Ollama daemons share. Authentication is a single optional
// bearer token.
//
// Capability → endpoints mapping:
//   capabilities includes "embedding" → kind: 'embedding',
//                                       endpoints: { openaiEmbeddings: {} }
//   otherwise (chat / vision / tools / thinking) → kind: 'chat',
//                                       endpoints: { openaiCompletions, openaiChatCompletions, openaiResponses, anthropicMessages }
//
// Vision, tool calling, and reasoning/thinking are request-time features, not
// per-endpoint capabilities, so they do not change routing. They surface to
// the dashboard via the model's `chat` field for display purposes only.
//
// Audio has no dedicated /api/show capability. The transcription route is
// therefore available only to manual config.models[] entries declaring the
// semantic endpoint; ordinary catalog rows stay chat/embedding.
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
//
// Manual config.models[] entries are emitted ahead of the auto-fetched
// catalog, and an auto row carrying the same upstreamModelId is dropped so the
// manual copy is the only one for that id.

import { chatFromOllamaRaw } from './chat-from-raw.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOllamaCatalog, type OllamaCatalog } from './fetch-models.ts';
import { createOllamaPipelines } from './pipelines.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { readOllamaUpstreamState } from './state.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type FlagId, type ProviderInstance, type Provider, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

// Vision / tool / thinking capabilities live alongside `embedding` in the
// /api/show response. Embedding is the only one that drives a different
// kind/endpoints projection — the others are request-time signals.
const CHAT_ENDPOINTS: ModelEndpoints = { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
const EMBEDDING_ENDPOINTS: ModelEndpoints = { openaiEmbeddings: {} };

const finalizeOllamaModels = (
  catalog: OllamaCatalog,
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const raw of catalog.data) {
    const endpoints = raw.capabilities.has('embedding') ? EMBEDDING_ENDPOINTS : CHAT_ENDPOINTS;
    const limits: ProviderModel['limits'] = {};
    if (raw.contextLength !== undefined) limits.max_context_window_tokens = raw.contextLength;
    const model: ProviderModel = {
      id: raw.id,
      upstreamModelId: raw.id,
      owned_by: 'ollama',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: raw.id,
      enabledFlags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
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

export const createOllamaProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertOllamaUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides]);
  const state = readOllamaUpstreamState(record.state);

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
      providerData: model.upstreamModelId,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    const pricing = model.pricing ?? pricingForOllamaModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      const catalog = await fetchOllamaCatalog(config, fetcher);
      const auto = finalizeOllamaModels(
        { data: catalog.data.filter(raw => !overriddenIds.has(raw.id)) },
        upstreamFlags,
      );
      return [...manualModels, ...auto];
    },
  };

  return {
    upstreamId: record.id,
    kind: 'ollama',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createOllamaPipelines(record.id, config, state),
    instance,
  };
};
