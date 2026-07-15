import { assertCustomUpstreamRecord, type CustomUpstreamConfig } from './config.ts';
import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import { customFetchChatCompletions, customFetchCompletions, customFetchEmbeddings, customFetchImagesEdits, customFetchImagesGenerations, customFetchMessages, customFetchMessagesCountTokens, customFetchResponses, customFetchResponsesCompact } from './fetch.ts';
import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesResult, toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { serializeOpenAIImagesEditsRequest, publicModelId, resolveEffectiveFlags, streamingProviderCall, type FlagId, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord } from '@floway-dev/provider';

const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

const customRawToProviderModel = (model: CustomRawModel): Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const partial: Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits: model.limits ? { ...model.limits } : {},
  };
  if (model.owned_by !== undefined) partial.owned_by = model.owned_by;
  // OpenAI carries unix `created`; Anthropic carries ISO `created_at`; our
  // own /models carries both. Prefer the unix integer when both are present,
  // otherwise derive it from the ISO string. We never store created_at on
  // ProviderModel — the public catalog rederives it from `created` so the
  // internal shape stays single-source.
  if (model.created !== undefined) {
    partial.created = model.created;
  } else if (model.created_at !== undefined) {
    const ms = Date.parse(model.created_at);
    if (!Number.isNaN(ms)) partial.created = Math.floor(ms / 1000);
  }
  const display = model.display_name ?? model.name;
  if (display !== undefined) partial.display_name = display;
  if (model.pricing) partial.pricing = model.pricing;
  return partial;
};

// A published kind of 'embedding'/'image' (Tier 1) maps directly to its
// endpoints; a published 'chat' takes the upstream's configured endpoints
// verbatim. With no/unrecognized published kind, the id heuristic (Tier 2) runs
// and falls back to the configured endpoints when it does not match. The
// configured set may be empty, leaving the model listed but unroutable until
// the operator declares an endpoint. `kind` is derived back from the endpoints.
const autoModelEndpoints = (model: CustomRawModel, configured: ModelEndpoints): ModelEndpoints => {
  if (model.kind === 'embedding') return { embeddings: {} };
  if (model.kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  if (model.kind === 'chat') return configured;
  return inferEndpointsFromModelId(model.id) ?? configured;
};

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredEndpoints: ModelEndpoints,
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    const endpoints = autoModelEndpoints(rawModel, configuredEndpoints);
    models.push({
      ...customRawToProviderModel(rawModel),
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: rawModel.id,
      enabledFlags,
    });
  }
  return models;
};

export const createCustomProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertCustomUpstreamRecord(record);
  const configuredEndpoints = config.endpoints;
  // Computed once for the auto-fetch layer: only the upstream layer applies to
  // auto models (no per-model override layer). Manual models layer their own
  // flag overrides on top, resolved per-model below.
  const upstreamFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides]);

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
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
    if (model.pricing) internal.pricing = model.pricing;
    if (model.chat) internal.chat = model.chat;
    return internal;
  });
  const call = (
    transport: (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Headers,
    opts: UpstreamCallOptions,
  ): Promise<ProviderCallResult> => {
    const rawModelId = rawModelIdOf(model);
    return transport(config, { method: 'POST', body: JSON.stringify({ ...body, model: rawModelId }), signal }, { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall })
      .then(response => ({
        response,
        modelKey: rawModelId,
      }));
  };

  const callStreaming = <TEvent>(
    transport: (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Headers,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const rawModelId = rawModelIdOf(model);
    return streamingProviderCall(
      transport(
        config,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: rawModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      rawModelId,
      signal,
    );
  };

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      if (!config.modelsFetch.enabled) return manualModels;
      const response = await fetchCustomModels(config, fetcher);
      const fetchedPricing = new Map(
        response.data.flatMap(model => model.pricing ? [[model.id, model.pricing] as const] : []),
      );
      const effectiveManualModels = manualModels.map(model => {
        if (model.pricing !== undefined) return model;
        const pricing = fetchedPricing.get(rawModelIdOf(model));
        return pricing === undefined ? model : { ...model, pricing };
      });
      // Drop any auto-fetched model whose id is pinned by a manual
      // override so the manual copy is the only one emitted for that id.
      const filtered: CustomModelsResponse = { data: response.data.filter(raw => !overriddenIds.has(raw.id)) };
      return [...effectiveManualModels, ...finalizeCustomModels(filtered, configuredEndpoints, upstreamFlags)];
    },
    callCompletions: (model, body, signal, opts) => call(customFetchCompletions, model, body, signal, opts.headers, opts),
    callChatCompletions: (model, body, signal, opts) => callStreaming(customFetchChatCompletions, model, body, signal, opts.headers, parseChatCompletionsStream, opts),
    callResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await callStreaming(customFetchResponses, model, body, signal, opts.headers, parseResponsesStream, opts);
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await customFetchResponsesCompact(
          config,
          { method: 'POST', body: JSON.stringify({ ...toCompactPayloadShape(body), model: rawModelId }), signal },
          { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        );
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as ResponsesResult, modelKey: rawModelId }
          : { action: 'compact', ok: false, response, modelKey: rawModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled ResponsesAction: ${action as string}`);
      }
    },
    callMessages: (model, body, signal, opts) => callStreaming(customFetchMessages, model, body, signal, opts.headers, parseMessagesStream, opts),
    callMessagesCountTokens: (model, body, signal, opts) => call(customFetchMessagesCountTokens, model, body, signal, opts.headers, opts),
    callEmbeddings: (model, body, signal, opts) => call(customFetchEmbeddings, model, body, signal, opts.headers, opts),
    callImagesGenerations: (model, body, signal, opts) => call(customFetchImagesGenerations, model, body, signal, opts.headers, opts),
    callImagesEdits: async (model, request, signal, opts) => {
      const rawModelId = rawModelIdOf(model);
      const body = await serializeOpenAIImagesEditsRequest(request, rawModelId);
      const response = await customFetchImagesEdits(config, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: rawModelId };
    },
  };

  return {
    upstream: record.id,
    kind: 'custom',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    instance,
  };
};
