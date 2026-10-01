import type { CustomUpstreamConfig } from './config.ts';
import { prepareCustomRequest } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderOperationPayloads, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createCustomPipelines = (config: CustomUpstreamConfig): ProviderPipelines => ({
  alphaSearch: compose<ProviderRequest<ProviderOperationPayloads['alphaSearch']>, ProviderOperationResponse<'alphaSearch'>>('custom.alphaSearch', [prepareCustomRequest(config, 'alphaSearch'), http]),
  openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('custom.openaiCompletions', [prepareCustomRequest(config, 'openaiCompletions'), http]),
  openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('custom.openaiEmbeddings', [prepareCustomRequest(config, 'openaiEmbeddings'), http]),
  openaiImagesGenerations: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesGenerations']>, ProviderOperationResponse<'openaiImagesGenerations'>>('custom.openaiImagesGenerations', [prepareCustomRequest(config, 'openaiImagesGenerations'), http]),
  openaiImagesEdits: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesEdits']>, ProviderOperationResponse<'openaiImagesEdits'>>('custom.openaiImagesEdits', [prepareCustomRequest(config, 'openaiImagesEdits'), http]),
  openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('custom.openaiAudioTranscriptions', [prepareCustomRequest(config, 'openaiAudioTranscriptions'), http]),
  rerank: compose<ProviderRequest<ProviderOperationPayloads['rerank']>, ProviderOperationResponse<'rerank'>>('custom.rerank', [prepareCustomRequest(config, 'rerank'), http]),
});
