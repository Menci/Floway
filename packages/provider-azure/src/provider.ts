import { assertAzureUpstreamRecord } from './config.ts';
import { azureFetchChatCompletions, azureFetchCompletions, azureFetchEmbeddings, azureFetchImagesEdits, azureFetchImagesGenerations, azureFetchMessages, azureFetchMessagesCountTokens, azureFetchResponses, azureFetchResponsesCompact } from './fetch.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesResult } from '@floway-dev/protocols/responses';
import { type ModelProvider, type ModelProviderInstance, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamModel, type UpstreamRecord, defaultsForProvider, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

const providerData = (model: UpstreamModel): { upstreamModelId: string } => model.providerData as { upstreamModelId: string };

type AzureTypedFetch = (config: ReturnType<typeof assertAzureUpstreamRecord>['config'], init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>;

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);

  const callStreaming = <TEvent>(
    transport: AzureTypedFetch,
    model: UpstreamModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Headers,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const upstreamModelId = providerData(model).upstreamModelId;
    return streamingProviderCall(
      transport(
        azure.config,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const callNonStreaming = async (transport: AzureTypedFetch, model: UpstreamModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers, opts: UpstreamCallOptions) => {
    const upstreamModelId = providerData(model).upstreamModelId;
    const response = await transport(azure.config, { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal }, { extraHeaders: headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency });
    return { response, modelKey: upstreamModelId };
  };

  const provider: ModelProvider = {
    getProvidedModels() {
      return Promise.resolve(azure.config.models.map(model => {
        const modelLayer = model.flagOverrides?.enabled ? model.flagOverrides.values : undefined;
        const effective = resolveEffectiveFlags(defaultsForProvider('azure'), [azure.flagOverrides, modelLayer]);
        const endpoints = model.endpoints;
        return {
          id: publicModelId(model),
          limits: { ...(model.limits ?? {}) },
          ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
          ...(model.cost ? { cost: model.cost } : {}),
          kind: kindForEndpoints(endpoints),
          endpoints,
          providerData: { upstreamModelId: model.upstreamModelId },
          enabledFlags: effective,
        };
      }));
    },
    getPricingForModelKey(modelKey) {
      return azure.config.models.find(model => model.upstreamModelId === modelKey)?.cost ?? null;
    },
    callCompletions: (model, body, signal, opts) => callNonStreaming(azureFetchCompletions, model, body, signal, opts.headers, opts),
    callChatCompletions: (model, body, signal, opts) => callStreaming(azureFetchChatCompletions, model, body, signal, opts.headers, parseChatCompletionsStream, opts),
    callResponses: (model, body, signal, opts) => callStreaming(azureFetchResponses, model, body, signal, opts.headers, parseResponsesStream, opts),
    callResponsesCompact: async (model, body, signal, opts) => {
      const upstreamModelId = providerData(model).upstreamModelId;
      const response = await azureFetchResponsesCompact(
        azure.config,
        { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal },
        { extraHeaders: opts.headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency },
      );
      return response.ok
        ? { ok: true, result: (await response.json()) as ResponsesResult, modelKey: upstreamModelId }
        : { ok: false, response, modelKey: upstreamModelId };
    },
    callMessages: (model, body, signal, opts) => callStreaming(azureFetchMessages, model, body, signal, opts.headers, parseMessagesStream, opts),
    callMessagesCountTokens: (model, body, signal, opts) => callNonStreaming(azureFetchMessagesCountTokens, model, body, signal, opts.headers, opts),
    callEmbeddings: (model, body, signal, opts) => callNonStreaming(azureFetchEmbeddings, model, body, signal, opts.headers, opts),
    callImagesGenerations: (model, body, signal, opts) => callNonStreaming(azureFetchImagesGenerations, model, body, signal, opts.headers, opts),
    callImagesEdits: async (model, body, signal, opts) => {
      // Azure routes by upstream model id in the multipart `model` field; the
      // runtime re-encodes the FormData with a fresh boundary and sets
      // Content-Type itself.
      const upstreamModelId = providerData(model).upstreamModelId;
      body.append('model', upstreamModelId);
      const response = await azureFetchImagesEdits(azure.config, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, recordUpstreamLatency: opts.recordUpstreamLatency });
      return { response, modelKey: upstreamModelId };
    },
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    disabledPublicModelIds: azure.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: true,
  };
};
