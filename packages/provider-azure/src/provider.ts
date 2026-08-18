import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { azureFetchAudioTranscriptions, azureFetchOpenAIChatCompletions, azureFetchCompletions, azureFetchEmbeddings, azureFetchImagesEdits, azureFetchImagesGenerations, azureFetchAnthropicMessages, azureFetchAnthropicMessagesCountTokens, azureFetchOpenAIResponses, azureFetchOpenAIResponsesCompact } from './fetch.ts';
import { AZURE_OPENAI_RESPONSES_BOUNDARY } from './interceptors/openai-responses/index.ts';
import type { OpenAIResponsesBoundaryCtx } from './interceptors/openai-responses/types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, serializeModelPathAudioTranscriptionRequest, serializeOpenAIImagesEditsRequest, type FetchInit, type ProviderInstance, type Provider, type ProviderModel, type ProviderOpenAIResponsesResult, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

const upstreamModelIdOf = (model: ProviderModel): string => (model.providerData as { upstreamModelId: string }).upstreamModelId;

type AzureTypedFetch = (config: ReturnType<typeof assertAzureUpstreamRecord>['config'], init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>;

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
        { method: 'POST', body: jsonRequestBody({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const callNonStreaming = async (transport: AzureTypedFetch, model: ProviderModel, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers, opts: UpstreamCallOptions) => {
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
    callCompletions: (model, body, signal, opts) => callNonStreaming(azureFetchCompletions, model, body, signal, opts.headers, opts),
    callOpenAIChatCompletions: (model, body, signal, opts) => callStreaming(azureFetchOpenAIChatCompletions, model, body, signal, opts.headers, parseOpenAIChatCompletionsStream, opts),
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      const ctx: OpenAIResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
        action,
      };
      return await runInterceptors<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult>(
        ctx, {}, AZURE_OPENAI_RESPONSES_BOUNDARY, async () => {
          const { model: _ignored, ...wireBody } = ctx.payload;
          switch (ctx.action) {
          case 'generate': {
            const stream = await callStreaming(azureFetchOpenAIResponses, model, wireBody, signal, ctx.headers, parseOpenAIResponsesStream, opts);
            return stream.ok
              ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
              : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
          }
          case 'compact': {
            const upstreamModelId = upstreamModelIdOf(model);
            const response = await azureFetchOpenAIResponsesCompact(
              azure.config,
              { method: 'POST', body: jsonRequestBody({ ...toCompactPayloadShape(wireBody), model: upstreamModelId }), signal },
              { extraHeaders: ctx.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
            );
            return response.ok
              ? { action: 'compact', ok: true, result: (await response.json()) as OpenAIResponsesCompactionResult, modelKey: upstreamModelId }
              : { action: 'compact', ok: false, response, modelKey: upstreamModelId };
          }
          default:
            ctx.action satisfies never;
            throw new Error(`Unhandled OpenAIResponsesAction: ${ctx.action as string}`);
          }
        },
      );
    },
    callAnthropicMessages: (model, body, signal, opts) => callStreaming(azureFetchAnthropicMessages, model, body, signal, headersForAnthropicMessagesCall(opts.headers, opts.anthropicBeta), parseAnthropicMessagesStream, opts),
    callAnthropicMessagesCountTokens: (model, body, signal, opts) => callNonStreaming(azureFetchAnthropicMessagesCountTokens, model, body, signal, headersForAnthropicMessagesCall(opts.headers, opts.anthropicBeta), opts),
    callEmbeddings: (model, body, signal, opts) => callNonStreaming(azureFetchEmbeddings, model, body, signal, opts.headers, opts),
    callImagesGenerations: (model, body, signal, opts) => callNonStreaming(azureFetchImagesGenerations, model, body, signal, opts.headers, opts),
    callImagesEdits: async (model, request, signal, opts) => {
      const upstreamModelId = upstreamModelIdOf(model);
      const body = await serializeOpenAIImagesEditsRequest(request, upstreamModelId);
      const response = await azureFetchImagesEdits(azure.config, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
      return { response, modelKey: upstreamModelId };
    },
    callAudioTranscriptions: async (model, request, signal, opts) => {
      const upstreamModelId = upstreamModelIdOf(model);
      const body = serializeModelPathAudioTranscriptionRequest(request);
      const response = await azureFetchAudioTranscriptions(azure.config, upstreamModelId, { method: 'POST', body, signal }, { extraHeaders: opts.headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
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
