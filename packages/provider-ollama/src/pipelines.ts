import type { OllamaUpstreamConfig } from './config.ts';
import { observeOllamaAccount } from './stages/observe-account.ts';
import { prepareOllamaRequest } from './stages/prepare-request.ts';
import type { OllamaUpstreamState } from './state.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import type { ProviderOperationPayloads, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createOllamaPipelines = (upstreamId: string, config: OllamaUpstreamConfig, state: OllamaUpstreamState): ProviderPipelines => {
  const observe = observeOllamaAccount(upstreamId, config, state);
  return {
    openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('ollama.openaiCompletions', [observe, prepareOllamaRequest(config, 'openaiCompletions'), http]),
    openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('ollama.openaiEmbeddings', [observe, prepareOllamaRequest(config, 'openaiEmbeddings'), http]),
    openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('ollama.openaiAudioTranscriptions', [observe, prepareOllamaRequest(config, 'openaiAudioTranscriptions'), http]),
  };
};
