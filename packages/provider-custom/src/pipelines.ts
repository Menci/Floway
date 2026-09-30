import type { CustomUpstreamConfig } from './config.ts';
import { prepareCustomRequest } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, selectProviderResponsesAction } from '@floway-dev/provider';
import type { ProviderOperationPayloads, ProviderOperationRequest, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createCustomPipelines = (config: CustomUpstreamConfig): ProviderPipelines => ({
  alphaSearch: compose<ProviderRequest<ProviderOperationPayloads['alphaSearch']>, ProviderOperationResponse<'alphaSearch'>>('custom.alphaSearch', [prepareCustomRequest(config, 'alphaSearch'), observeProviderCall, http]),
  openaiChatCompletions: compose<ProviderOperationRequest<'openaiChatCompletions'>, ProviderOperationResponse<'openaiChatCompletions'>>('custom.openaiChatCompletions', [decodeProviderResponse('openaiChatCompletions'), prepareCustomRequest(config, 'openaiChatCompletions'), observeProviderCall, http]),
  openaiResponses: compose<ProviderOperationRequest<'openaiResponses'>, ProviderOperationResponse<'openaiResponses'>>('custom.openaiResponses', [selectProviderResponsesAction('generate'), decodeProviderResponse('openaiResponses'), prepareCustomRequest(config, 'openaiResponses'), observeProviderCall, http]),
  openaiResponsesCompact: compose<ProviderOperationRequest<'openaiResponsesCompact'>, ProviderOperationResponse<'openaiResponsesCompact'>>('custom.openaiResponsesCompact', [selectProviderResponsesAction('compact'), decodeProviderResponse('openaiResponsesCompact'), prepareCustomRequest(config, 'openaiResponsesCompact'), observeProviderCall, http]),
  anthropicMessages: compose<ProviderOperationRequest<'anthropicMessages'>, ProviderOperationResponse<'anthropicMessages'>>('custom.anthropicMessages', [decodeProviderResponse('anthropicMessages'), prepareCustomRequest(config, 'anthropicMessages'), observeProviderCall, http]),
  anthropicMessagesCountTokens: compose<ProviderOperationRequest<'anthropicMessagesCountTokens'>, ProviderOperationResponse<'anthropicMessagesCountTokens'>>('custom.anthropicMessagesCountTokens', [decodeProviderResponse('anthropicMessagesCountTokens'), prepareCustomRequest(config, 'anthropicMessagesCountTokens'), observeProviderCall, http]),
  openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('custom.openaiCompletions', [prepareCustomRequest(config, 'openaiCompletions'), observeProviderCall, http]),
  openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('custom.openaiEmbeddings', [prepareCustomRequest(config, 'openaiEmbeddings'), observeProviderCall, http]),
  openaiImagesGenerations: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesGenerations']>, ProviderOperationResponse<'openaiImagesGenerations'>>('custom.openaiImagesGenerations', [prepareCustomRequest(config, 'openaiImagesGenerations'), observeProviderCall, http]),
  openaiImagesEdits: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesEdits']>, ProviderOperationResponse<'openaiImagesEdits'>>('custom.openaiImagesEdits', [prepareCustomRequest(config, 'openaiImagesEdits'), observeProviderCall, http]),
  openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('custom.openaiAudioTranscriptions', [prepareCustomRequest(config, 'openaiAudioTranscriptions'), observeProviderCall, http]),
  rerank: compose<ProviderRequest<ProviderOperationPayloads['rerank']>, ProviderOperationResponse<'rerank'>>('custom.rerank', [prepareCustomRequest(config, 'rerank'), observeProviderCall, http]),
});
