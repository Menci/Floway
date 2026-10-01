import type { AzureUpstreamConfig } from './config.ts';
import { fillAzureNamespaceDescriptions } from './stages/fill-namespace-descriptions.ts';
import { prepareAzureRequest } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, observeProviderResponsesCall, selectProviderResponsesAction } from '@floway-dev/provider';
import type { ProviderOperationPayloads, ProviderOperationRequest, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createAzurePipelines = (config: AzureUpstreamConfig): ProviderPipelines => ({
  openaiChatCompletions: compose<ProviderOperationRequest<'openaiChatCompletions'>, ProviderOperationResponse<'openaiChatCompletions'>>('azure.openaiChatCompletions', [decodeProviderResponse('openaiChatCompletions'), prepareAzureRequest(config, 'openaiChatCompletions'), observeProviderCall, http]),
  openaiResponses: compose<ProviderOperationRequest<'openaiResponses'>, ProviderOperationResponse<'openaiResponses'>>('azure.openaiResponses', [selectProviderResponsesAction('generate'), fillAzureNamespaceDescriptions, decodeProviderResponse('openaiResponses'), prepareAzureRequest(config, 'openaiResponses'), observeProviderResponsesCall, http]),
  openaiResponsesCompact: compose<ProviderOperationRequest<'openaiResponsesCompact'>, ProviderOperationResponse<'openaiResponsesCompact'>>('azure.openaiResponsesCompact', [selectProviderResponsesAction('compact'), fillAzureNamespaceDescriptions, decodeProviderResponse('openaiResponsesCompact'), prepareAzureRequest(config, 'openaiResponsesCompact'), observeProviderResponsesCall, http]),
  anthropicMessages: compose<ProviderOperationRequest<'anthropicMessages'>, ProviderOperationResponse<'anthropicMessages'>>('azure.anthropicMessages', [decodeProviderResponse('anthropicMessages'), prepareAzureRequest(config, 'anthropicMessages'), observeProviderCall, http]),
  anthropicMessagesCountTokens: compose<ProviderOperationRequest<'anthropicMessagesCountTokens'>, ProviderOperationResponse<'anthropicMessagesCountTokens'>>('azure.anthropicMessagesCountTokens', [decodeProviderResponse('anthropicMessagesCountTokens'), prepareAzureRequest(config, 'anthropicMessagesCountTokens'), observeProviderCall, http]),
  openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('azure.openaiCompletions', [prepareAzureRequest(config, 'openaiCompletions'), observeProviderCall, http]),
  openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('azure.openaiEmbeddings', [prepareAzureRequest(config, 'openaiEmbeddings'), observeProviderCall, http]),
  openaiImagesGenerations: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesGenerations']>, ProviderOperationResponse<'openaiImagesGenerations'>>('azure.openaiImagesGenerations', [prepareAzureRequest(config, 'openaiImagesGenerations'), observeProviderCall, http]),
  openaiImagesEdits: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesEdits']>, ProviderOperationResponse<'openaiImagesEdits'>>('azure.openaiImagesEdits', [prepareAzureRequest(config, 'openaiImagesEdits'), observeProviderCall, http]),
  openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('azure.openaiAudioTranscriptions', [prepareAzureRequest(config, 'openaiAudioTranscriptions'), observeProviderCall, http]),
});
