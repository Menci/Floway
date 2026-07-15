import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { azureFetchChatCompletions, azureFetchCompletions, azureFetchEmbeddings, azureFetchImagesEdits, azureFetchImagesGenerations, azureFetchMessages, azureFetchMessagesCountTokens, azureFetchResponses, azureFetchResponsesCompact } from './fetch.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesResult, toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { serializeOpenAIImagesEditsRequest, type ProviderInstance, type Provider, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

const upstreamModelIdOf = (model: ProviderModel): string => (model.providerData as { upstreamModelId: string }).upstreamModelId;

type AzureTypedFetch = (config: ReturnType<typeof assertAzureUpstreamRecord>['config'], init: RequestInit, options: UpstreamFetchOptions) => Promise<Response>;

export const createAzureProvider = (record: UpstreamRecord): Provider => {
  const azure = assertAzureUpstreamRecord(record);

  const callStreaming = <TEvent>(
    transport: AzureTypedFetch,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Headers,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const upstreamModelId = upstreamModelIdOf(model);
    return streamingProviderCall(
      transport(
        azure.config,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const callNonStreaming = async (transport: AzureTypedFetch, model: ProviderModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers, opts: UpstreamCallOptions) => {
    const upstreamModelId = upstreamModelIdOf(model);
    const response = await transport(azure.config, { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal }, { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
    return { response, modelKey: upstreamModelId };
  };

  const instance: ProviderInstance = {
    getProvidedModels() {
      return Promise.resolve(azure.config.models.map(model => {
        const effective = resolveEffectiveFlags([AZURE_DEFAULT_FLAGS, azure.flagOverrides, model.flagOverrides]);
        const endpoints = model.endpoints;
        return {
          id: publicModelId(model),
          limits: { ...(model.limits ?? {}) },
          ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
          ...(model.pricing ? { pricing: model.pricing } : {}),
          ...(model.chat ? { chat: model.chat } : {}),
          kind: kindForEndpoints(endpoints),
          endpoints,
          providerData: { upstreamModelId: model.upstreamModelId },
          enabledFlags: effective,
        };
      }));
    },
    callCompletions: (model, body, signal, opts) => callNonStreaming(azureFetchCompletions, model, body, signal, opts.headers, opts),
    callChatCompletions: (model, body, signal, opts) => callStreaming(azureFetchChatCompletions, model, body, signal, opts.headers, parseChatCompletionsStream, opts),
    callResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await callStreaming(azureFetchResponses, model, body, signal, opts.headers, parseResponsesStream, opts);
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const upstreamModelId = upstreamModelIdOf(model);
        const response = await azureFetchResponsesCompact(
          azure.config,
          { method: 'POST', body: JSON.stringify({ ...toCompactPayloadShape(body), model: upstreamModelId }), signal },
          { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        );
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as ResponsesResult, modelKey: upstreamModelId }
          : { action: 'compact', ok: false, response, modelKey: upstreamModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled ResponsesAction: ${action as string}`);
      }
    },
    callMessages: (model, body, signal, opts) => callStreaming(azureFetchMessages, model, body, signal, opts.headers, parseMessagesStream, opts),
    callMessagesCountTokens: (model, body, signal, opts) => callNonStreaming(azureFetchMessagesCountTokens, model, body, signal, opts.headers, opts),
    callEmbeddings: (model, body, signal, opts) => callNonStreaming(azureFetchEmbeddings, model, body, signal, opts.headers, opts),
    callImagesGenerations: (model, body, signal, opts) => callNonStreaming(azureFetchImagesGenerations, model, body, signal, opts.headers, opts),
    callImagesEdits: async (model, request, signal, opts) => {
      const upstreamModelId = upstreamModelIdOf(model);
      const body = await serializeOpenAIImagesEditsRequest(request, upstreamModelId);
      const response = await azureFetchImagesEdits(azure.config, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: upstreamModelId };
    },
  };

  return {
    upstream: azure.id,
    kind: 'azure',
    name: azure.name,
    disabledPublicModelIds: azure.disabledPublicModelIds,
    modelPrefix: azure.modelPrefix,
    instance,
  };
};
