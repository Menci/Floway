import type { OllamaServices } from '../service.ts';
import type { OllamaUpstream } from '../upstream.ts';
import { parseResponse as parseAnthropicMessagesCountTokensResponse } from './anthropic-messages-count-tokens/parse-response.ts';
import { dial as dialDecision } from './decision/dial.ts';
import { parseResponse as parseDecisionResponse } from './decision/parse-response.ts';
import { jsonRequest, ollamaDial } from './dial.ts';
import { formatAnthropicError, formatOpenAIError } from './errors.ts';
import { compose } from './facts.ts';
import { parseJsonObject } from './json-result.ts';
import { dial as dialOpenAIAudioTranscriptions } from './openai-audio-transcriptions/dial.ts';
import { parseResponse as parseOpenAIAudioTranscriptionsResponse } from './openai-audio-transcriptions/parse-response.ts';
import { renameOutputCapStage } from './openai-chat-completions/rename-output-cap.ts';
import { normalizeDeepSeek as normalizeDeepSeekOpenAIChatCompletions } from './openai-chat-completions/vendor-deepseek-normalize.ts';
import { normalizeKimi } from './openai-chat-completions/vendor-kimi-normalize.ts';
import { normalizeQwen as normalizeQwenOpenAIChatCompletions } from './openai-chat-completions/vendor-qwen-normalize.ts';
import { parseResponse as parseOpenAICompletionsResponse } from './openai-completions/parse-response.ts';
import { normalizeDeepSeek as normalizeDeepSeekOpenAIResponses } from './openai-responses/vendor-deepseek-normalize.ts';
import { normalizeQwen as normalizeQwenOpenAIResponses } from './openai-responses/vendor-qwen-normalize.ts';
import { dial as dialOpenAIResponsesCompact } from './openai-responses-compact/dial.ts';
import { parseResponse as parseOpenAIResponsesCompactResponse } from './openai-responses-compact/parse-response.ts';
import { refreshProbes } from './refresh-probes.ts';
import { stripAnthropicMessagesHeaders, stripOllamaHeaders } from './strip-headers.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, parseResultResponse, parseSseResponse, type ProviderPipelines } from '@floway-dev/provider';

const commonEntry = ['request.http', 'provider.upstream', 'provider.model'] as const;

// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1906-L1922
export const ollamaPipelines = Object.freeze({
  anthropicMessages: compose('ollama.anthropicMessages', {
    entry: [...commonEntry, 'request.anthropicMessages'],
    exit: ['response.http', 'response.anthropicMessages', 'response.usageModelKey?'],
    stages: [
      stripAnthropicMessagesHeaders,
      parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, formatAnthropicError),
      ollamaDial('anthropicMessages', (body, model) => jsonRequest('/v1/messages', { ...body, model: model.upstreamModelId, stream: true }), formatAnthropicError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose('ollama.anthropicMessagesCountTokens', {
    entry: [...commonEntry, 'request.anthropicMessagesCountTokens'],
    exit: ['response.http', 'response.anthropicMessagesCountTokens', 'response.usageModelKey?'],
    stages: [
      stripAnthropicMessagesHeaders,
      parseAnthropicMessagesCountTokensResponse,
      // https://platform.claude.com/docs/en/api/messages/count_tokens
      ollamaDial('anthropicMessagesCountTokens', (body, model) => jsonRequest('/v1/messages/count_tokens', { ...body, model: model.upstreamModelId }), formatAnthropicError),
    ],
    ending: httpTerminal,
  }),
  decision: compose('ollama.decision', {
    entry: [...commonEntry, 'request.decision'],
    exit: ['response.http', 'response.decision', 'response.usageModelKey?'],
    stages: [stripOllamaHeaders, parseDecisionResponse, dialDecision],
    ending: httpTerminal,
  }),
  openaiAudioTranscriptions: compose('ollama.openaiAudioTranscriptions', {
    entry: [...commonEntry, 'request.openaiAudioTranscriptions'],
    exit: ['response.http', 'response.openaiAudioTranscriptions', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      parseOpenAIAudioTranscriptionsResponse,
      dialOpenAIAudioTranscriptions,
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiChatCompletions: compose('ollama.openaiChatCompletions', {
    entry: [...commonEntry, 'request.openaiChatCompletions'],
    exit: ['response.http', 'response.openaiChatCompletions', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      renameOutputCapStage,
      normalizeDeepSeekOpenAIChatCompletions,
      normalizeQwenOpenAIChatCompletions,
      normalizeKimi,
      parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, formatOpenAIError),
      ollamaDial('openaiChatCompletions', (body, model) => jsonRequest('/v1/chat/completions', { ...body, model: model.upstreamModelId, stream: true }), formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiCompletions: compose('ollama.openaiCompletions', {
    entry: [...commonEntry, 'request.openaiCompletions'],
    exit: ['response.http', 'response.openaiCompletions', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      parseOpenAICompletionsResponse,
      ollamaDial('openaiCompletions', (body, model) => jsonRequest('/v1/completions', { ...body, model: model.upstreamModelId }), formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiEmbeddings: compose('ollama.openaiEmbeddings', {
    entry: [...commonEntry, 'request.openaiEmbeddings'],
    exit: ['response.http', 'response.openaiEmbeddings', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      parseResultResponse('openaiEmbeddings', parseJsonObject, formatOpenAIError),
      ollamaDial('openaiEmbeddings', (body, model) => jsonRequest('/v1/embeddings', { ...body, model: model.upstreamModelId }), formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose('ollama.openaiResponses', {
    entry: [...commonEntry, 'request.openaiResponses'],
    exit: ['response.http', 'response.openaiResponses', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      normalizeDeepSeekOpenAIResponses,
      normalizeQwenOpenAIResponses,
      parseSseResponse('openaiResponses', decodeOpenAIResponsesStream, formatOpenAIError),
      ollamaDial('openaiResponses', (body, model) => jsonRequest('/v1/responses', { ...body, model: model.upstreamModelId, stream: true }), formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiResponsesCompact: compose('ollama.openaiResponsesCompact', {
    entry: [...commonEntry, 'request.openaiResponsesCompact'],
    exit: ['response.http', 'response.openaiResponsesCompact', 'response.usageModelKey?'],
    stages: [
      stripOllamaHeaders,
      parseOpenAIResponsesCompactResponse,
      dialOpenAIResponsesCompact,
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<OllamaServices, OllamaUpstream>);
