import type { AzureUpstreamConfig } from './config.ts';
import { prepareAzureRequest } from './stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderOperationPayloads, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createAzurePipelines = (config: AzureUpstreamConfig): ProviderPipelines => ({
  openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('azure.openaiCompletions', [prepareAzureRequest(config, 'openaiCompletions'), http]),
  openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('azure.openaiEmbeddings', [prepareAzureRequest(config, 'openaiEmbeddings'), http]),
  openaiImagesGenerations: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesGenerations']>, ProviderOperationResponse<'openaiImagesGenerations'>>('azure.openaiImagesGenerations', [prepareAzureRequest(config, 'openaiImagesGenerations'), http]),
  openaiImagesEdits: compose<ProviderRequest<ProviderOperationPayloads['openaiImagesEdits']>, ProviderOperationResponse<'openaiImagesEdits'>>('azure.openaiImagesEdits', [prepareAzureRequest(config, 'openaiImagesEdits'), http]),
  openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('azure.openaiAudioTranscriptions', [prepareAzureRequest(config, 'openaiAudioTranscriptions'), http]),
});
