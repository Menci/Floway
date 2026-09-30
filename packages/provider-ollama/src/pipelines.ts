import type { OllamaUpstreamConfig } from './config.ts';
import { observeOllamaAccount } from './stages/observe-account.ts';
import { prepareOllamaRequest } from './stages/prepare-request.ts';
import type { OllamaUpstreamState } from './state.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose } from '@floway-dev/pipeline';
import { decodeProviderResponse, observeProviderCall, selectProviderResponsesAction } from '@floway-dev/provider';
import type { ProviderOperationPayloads, ProviderOperationRequest, ProviderOperationResponse, ProviderPipelines, ProviderRequest } from '@floway-dev/provider';

export const createOllamaPipelines = (upstreamId: string, config: OllamaUpstreamConfig, state: OllamaUpstreamState): ProviderPipelines => {
  const observe = observeOllamaAccount(upstreamId, config, state);
  return {
    openaiChatCompletions: compose<ProviderOperationRequest<'openaiChatCompletions'>, ProviderOperationResponse<'openaiChatCompletions'>>('ollama.openaiChatCompletions', [observe, decodeProviderResponse('openaiChatCompletions'), prepareOllamaRequest(config, 'openaiChatCompletions'), observeProviderCall, http]),
    openaiResponses: compose<ProviderOperationRequest<'openaiResponses'>, ProviderOperationResponse<'openaiResponses'>>('ollama.openaiResponses', [observe, selectProviderResponsesAction('generate'), decodeProviderResponse('openaiResponses'), prepareOllamaRequest(config, 'openaiResponses'), observeProviderCall, http]),
    openaiResponsesCompact: compose<ProviderOperationRequest<'openaiResponsesCompact'>, ProviderOperationResponse<'openaiResponsesCompact'>>('ollama.openaiResponsesCompact', [observe, selectProviderResponsesAction('compact'), decodeProviderResponse('openaiResponsesCompact'), prepareOllamaRequest(config, 'openaiResponsesCompact'), observeProviderCall, http]),
    anthropicMessages: compose<ProviderOperationRequest<'anthropicMessages'>, ProviderOperationResponse<'anthropicMessages'>>('ollama.anthropicMessages', [observe, decodeProviderResponse('anthropicMessages'), prepareOllamaRequest(config, 'anthropicMessages'), observeProviderCall, http]),
    anthropicMessagesCountTokens: compose<ProviderOperationRequest<'anthropicMessagesCountTokens'>, ProviderOperationResponse<'anthropicMessagesCountTokens'>>('ollama.anthropicMessagesCountTokens', [decodeProviderResponse('anthropicMessagesCountTokens'), prepareOllamaRequest(config, 'anthropicMessagesCountTokens'), observeProviderCall, http]),
    openaiCompletions: compose<ProviderRequest<ProviderOperationPayloads['openaiCompletions']>, ProviderOperationResponse<'openaiCompletions'>>('ollama.openaiCompletions', [observe, prepareOllamaRequest(config, 'openaiCompletions'), observeProviderCall, http]),
    openaiEmbeddings: compose<ProviderRequest<ProviderOperationPayloads['openaiEmbeddings']>, ProviderOperationResponse<'openaiEmbeddings'>>('ollama.openaiEmbeddings', [observe, prepareOllamaRequest(config, 'openaiEmbeddings'), observeProviderCall, http]),
    openaiAudioTranscriptions: compose<ProviderRequest<ProviderOperationPayloads['openaiAudioTranscriptions']>, ProviderOperationResponse<'openaiAudioTranscriptions'>>('ollama.openaiAudioTranscriptions', [observe, prepareOllamaRequest(config, 'openaiAudioTranscriptions'), observeProviderCall, http]),
  };
};
