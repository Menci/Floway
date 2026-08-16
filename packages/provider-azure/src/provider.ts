import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { azureFetchAudioTranscriptions, azureFetchChatCompletions, azureFetchCompletions, azureFetchEmbeddings, azureFetchImagesEdits, azureFetchImagesGenerations, azureFetchMessages, azureFetchMessagesCountTokens, azureFetchResponses, azureFetchResponsesCompact } from './fetch.ts';
import { AZURE_RESPONSES_BOUNDARY } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/responses';
import { headersForMessagesCall, jsonRequestBody, serializeModelPathAudioTranscriptionRequest, serializeOpenAIImagesEditsRequest, type FetchInit, type HttpHeaderLines, type ProviderInstance, type Provider, type ProviderModel, type ProviderResponsesResult, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

const upstreamModelIdOf = (model: ProviderModel): string => (model.providerData as { upstreamModelId: string }).upstreamModelId;

type AzureTypedFetch = (config: ReturnType<typeof assertAzureUpstreamRecord>['config'], init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>;

export const createAzureProvider = (record: UpstreamRecord): Provider => {
  const azure = assertAzureUpstreamRecord(record);

  const callStreaming = <TEvent>(
    transport: AzureTypedFetch,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: HttpHeaderLines,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const upstreamModelId = upstreamModelIdOf(model);
    return streamingProviderCall(
      transport(
        azure.config,
        { method: 'POST', body: jsonRequestBody({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const callNonStreaming = async (transport: AzureTypedFetch, model: ProviderModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, opts: UpstreamCallOptions) => {
    const upstreamModelId = upstreamModelIdOf(model);
    const response = await transport(azure.config, { method: 'POST', body: jsonRequestBody({ ...body, model: upstreamModelId }), signal }, { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
    return { response, modelKey: upstreamModelId };
  };

  const instance: ProviderInstance = {
    callAlphaSearch: () => Promise.reject(new Error('Azure provider does not support callAlphaSearch')),
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
    callCompletions: (model, body, signal, opts) => callNonStreaming(azureFetchCompletions, model, body, signal, [...opts.headers], opts),
    callChatCompletions: (model, body, signal, opts) => callStreaming(azureFetchChatCompletions, model, body, signal, [...opts.headers], parseChatCompletionsStream, opts),
    callResponses: async (model, body, action, signal, opts) => {
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
        action,
      };
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderResponsesResult>(
        ctx, {}, AZURE_RESPONSES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          switch (ctx.action) {
          case 'generate': {
            const stream = await callStreaming(azureFetchResponses, model, wireBody, signal, [...ctx.headers], parseResponsesStream, opts);
            return stream.ok
              ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
              : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
          }
          case 'compact': {
            const upstreamModelId = upstreamModelIdOf(model);
            const response = await azureFetchResponsesCompact(
              azure.config,
              { method: 'POST', body: jsonRequestBody({ ...toCompactPayloadShape(wireBody), model: upstreamModelId }), signal },
              { extraHeaders: [...ctx.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
            );
            return response.ok
              ? { action: 'compact', ok: true, result: (await response.json()) as ResponsesCompactionResult, modelKey: upstreamModelId }
              : { action: 'compact', ok: false, response, modelKey: upstreamModelId };
          }
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled ResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },
    callMessages: (model, body, signal, opts) => callStreaming(azureFetchMessages, model, body, signal, headersForMessagesCall([...opts.headers], opts.anthropicBeta), parseMessagesStream, opts),
    callMessagesCountTokens: (model, body, signal, opts) => callNonStreaming(azureFetchMessagesCountTokens, model, body, signal, headersForMessagesCall([...opts.headers], opts.anthropicBeta), opts),
    callEmbeddings: (model, body, signal, opts) => callNonStreaming(azureFetchEmbeddings, model, body, signal, [...opts.headers], opts),
    callImagesGenerations: (model, body, signal, opts) => callNonStreaming(azureFetchImagesGenerations, model, body, signal, [...opts.headers], opts),
    callImagesEdits: async (model, request, signal, opts) => {
      const upstreamModelId = upstreamModelIdOf(model);
      const body = await serializeOpenAIImagesEditsRequest(request, upstreamModelId);
      const response = await azureFetchImagesEdits(azure.config, { method: 'POST', body, signal }, { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: upstreamModelId };
    },
    callAudioTranscriptions: async (model, request, signal, opts) => {
      const upstreamModelId = upstreamModelIdOf(model);
      const body = serializeModelPathAudioTranscriptionRequest(request);
      const response = await azureFetchAudioTranscriptions(azure.config, upstreamModelId, { method: 'POST', body, signal }, { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: upstreamModelId };
    },
    callRerank: () => Promise.reject(new Error('Azure provider does not support callRerank')),
  };

  return {
    upstreamId: azure.id,
    kind: 'azure',
    name: azure.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: azure.disabledPublicModelIds,
    modelPrefix: azure.modelPrefix,
    modelsCache: azure.modelsCache,
    instance,
  };
};
