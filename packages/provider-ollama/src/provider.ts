// Ollama provider. Builds a ProviderModel catalog from /api/tags + /api/show
// (see fetch-models.ts) and routes inference through Ollama's OpenAI-/
// Anthropic-compat shims at /v1/chat/completions, /v1/responses, /v1/messages,
// /v1/completions, /v1/embeddings, /v1/audio/transcriptions — the same paths the cloud (ollama.com) and
// self-hosted Ollama daemons share. Authentication is a single optional
// bearer token.
//
// Capability → endpoints mapping:
//   capabilities includes "embedding" → kind: 'embedding',
//                                       endpoints: { embeddings: {} }
//   otherwise (chat / vision / tools / thinking) → kind: 'chat',
//                                       endpoints: { completions, chatCompletions, responses, messages }
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
import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOllamaCatalog, type OllamaCatalog } from './fetch-models.ts';
import { ollamaFetchAudioTranscriptions, ollamaFetchChatCompletions, ollamaFetchCompletions, ollamaFetchEmbeddings, ollamaFetchMessages, ollamaFetchMessagesCountTokens, ollamaFetchResponses, ollamaFetchResponsesCompact } from './fetch.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { headersForMessagesCall, publicModelId, resolveEffectiveFlags, serializeOpenAIAudioTranscriptionRequest, streamingProviderCall, type FlagId, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord } from '@floway-dev/provider';

// providerData carries the raw upstream id verbatim — the same value /api/tags
// returns and the same value the gateway must send back on every inference call.
const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

// Vision / tool / thinking capabilities live alongside `embedding` in the
// /api/show response. Embedding is the only one that drives a different
// kind/endpoints projection — the others are request-time signals.
const CHAT_ENDPOINTS: ModelEndpoints = { completions: {}, chatCompletions: {}, responses: {}, messages: {} };
const EMBEDDING_ENDPOINTS: ModelEndpoints = { embeddings: {} };

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
      owned_by: 'ollama',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: raw.id,
      enabledFlags,
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

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([OLLAMA_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const internal: ProviderModel = {
      id: publicModelId(model),
      limits: { ...(model.limits ?? {}) },
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: model.upstreamModelId,
      enabledFlags,
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    const pricing = model.pricing ?? pricingForOllamaModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (model.chat) internal.chat = model.chat;
    return internal;
  });
  const call = (
    transport: (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    opts: UpstreamCallOptions,
  ): Promise<ProviderCallResult> => {
    const rawModelId = rawModelIdOf(model);
    return transport(
      config,
      { method: 'POST', body: JSON.stringify({ ...body, model: rawModelId }), signal },
      { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
    ).then(response => ({ response, modelKey: rawModelId }));
  };

  const callStreaming = <TEvent>(
    transport: (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const rawModelId = rawModelIdOf(model);
    return streamingProviderCall(
      transport(
        config,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: rawModelId }), signal },
        { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      rawModelId,
      signal,
    );
  };

  const rejectUnsupported = (capability: string) => () =>
    Promise.reject(new Error(`Ollama provider does not implement ${capability}`));

  const instance: ProviderInstance = {
    callAlphaSearch: rejectUnsupported('callAlphaSearch'),
    getProvidedModels: async fetcher => {
      const catalog = await fetchOllamaCatalog(config, fetcher);
      const auto = finalizeOllamaModels(
        { data: catalog.data.filter(raw => !overriddenIds.has(raw.id)) },
        upstreamFlags,
      );
      return [...manualModels, ...auto];
    },
    callCompletions: (model, body, signal, opts) => call(ollamaFetchCompletions, model, body, signal, opts),
    callChatCompletions: (model, body, signal, opts) => callStreaming(ollamaFetchChatCompletions, model, body, signal, parseChatCompletionsStream, opts),
    callResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await callStreaming(ollamaFetchResponses, model, body, signal, parseResponsesStream, opts);
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await ollamaFetchResponsesCompact(
          config,
          { method: 'POST', body: JSON.stringify({ ...toCompactPayloadShape(body), model: rawModelId }), signal },
          { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        );
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as ResponsesCompactionResult, modelKey: rawModelId }
          : { action: 'compact', ok: false, response, modelKey: rawModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled ResponsesAction: ${action as string}`);
      }
    },
    callMessages: (model, body, signal, opts) => callStreaming(ollamaFetchMessages, model, body, signal, parseMessagesStream, { ...opts, headers: headersForMessagesCall(opts.headers, opts.anthropicBeta) }),
    callMessagesCountTokens: (model, body, signal, opts) => call(ollamaFetchMessagesCountTokens, model, body, signal, { ...opts, headers: headersForMessagesCall(opts.headers, opts.anthropicBeta) }),
    callEmbeddings: (model, body, signal, opts) => call(ollamaFetchEmbeddings, model, body, signal, opts),
    // Ollama serves no image-generation endpoint; reject if the gateway ever
    // routes one here. /v1/images/* is not exposed by the upstream binary.
    callImagesGenerations: rejectUnsupported('callImagesGenerations'),
    callImagesEdits: rejectUnsupported('callImagesEdits'),
    callAudioTranscriptions: async (model, request, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      const body = serializeOpenAIAudioTranscriptionRequest(request, rawModelId);
      const response = await ollamaFetchAudioTranscriptions(config, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: rawModelId };
    },
    callRerank: rejectUnsupported('callRerank'),
  };

  return {
    upstreamId: record.id,
    kind: 'ollama',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
