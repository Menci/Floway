import type { KimiCodeServices } from '../service.ts';
import type { KimiCodeUpstream } from '../upstream.ts';
import { selectModel as selectAnthropicMessagesModel } from './anthropic-messages/select-model.ts';
import { selectModel as selectAnthropicMessagesCountTokensModel } from './anthropic-messages-count-tokens/select-model.ts';
import { formatAnthropicError, formatOpenAIError, kimiCodeDial } from './dial.ts';
import { compose } from './facts.ts';
import { selectModel as selectOpenAIChatCompletionsModel } from './openai-chat-completions/select-model.ts';
import { normalizeDeepSeek as normalizeDeepSeekOpenAIChatCompletions } from './openai-chat-completions/vendor-deepseek-normalize.ts';
import { normalizeKimi } from './openai-chat-completions/vendor-kimi-normalize.ts';
import { normalizeQwen as normalizeQwenOpenAIChatCompletions } from './openai-chat-completions/vendor-qwen-normalize.ts';
import { selectModel as selectOpenAIResponsesModel } from './openai-responses/select-model.ts';
import { normalizeDeepSeek as normalizeDeepSeekOpenAIResponses } from './openai-responses/vendor-deepseek-normalize.ts';
import { normalizeQwen as normalizeQwenOpenAIResponses } from './openai-responses/vendor-qwen-normalize.ts';
import { refreshProbes } from './refresh-probes.ts';
import { stripAnthropicMessagesHeaders, stripOpenAIHeaders } from './strip-headers.ts';
import { decodeAnthropicMessagesCountTokensResult, decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { httpTerminal, parseJsonBody, parseResultResponse, parseSseResponse, type ProviderPipelines } from '@floway-dev/provider';

const commonEntry = ['request.http', 'provider.upstream', 'provider.model'] as const;

// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://platform.claude.com/docs/en/api/messages/count_tokens
export const kimiCodePipelines = Object.freeze({
  openaiChatCompletions: compose('kimi-code.openaiChatCompletions', {
    entry: [...commonEntry, 'request.openaiChatCompletions'],
    exit: ['response.http', 'response.openaiChatCompletions', 'response.usageModelKey?'],
    stages: [
      stripOpenAIHeaders,
      selectOpenAIChatCompletionsModel,
      normalizeDeepSeekOpenAIChatCompletions,
      normalizeQwenOpenAIChatCompletions,
      normalizeKimi,
      parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, formatOpenAIError),
      kimiCodeDial('openaiChatCompletions', '/chat/completions', formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose('kimi-code.openaiResponses', {
    entry: [...commonEntry, 'request.openaiResponses'],
    exit: ['response.http', 'response.openaiResponses', 'response.usageModelKey?'],
    stages: [
      stripOpenAIHeaders,
      selectOpenAIResponsesModel,
      normalizeDeepSeekOpenAIResponses,
      normalizeQwenOpenAIResponses,
      parseSseResponse('openaiResponses', decodeOpenAIResponsesStream, formatOpenAIError),
      kimiCodeDial('openaiResponses', '/responses', formatOpenAIError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  anthropicMessages: compose('kimi-code.anthropicMessages', {
    entry: [...commonEntry, 'request.anthropicMessages'],
    exit: ['response.http', 'response.anthropicMessages', 'response.usageModelKey?'],
    stages: [
      stripAnthropicMessagesHeaders,
      selectAnthropicMessagesModel,
      parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, formatAnthropicError),
      kimiCodeDial('anthropicMessages', '/messages', formatAnthropicError),
      refreshProbes,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose('kimi-code.anthropicMessagesCountTokens', {
    entry: [...commonEntry, 'request.anthropicMessagesCountTokens'],
    exit: ['response.http', 'response.anthropicMessagesCountTokens', 'response.usageModelKey?'],
    stages: [
      stripAnthropicMessagesHeaders,
      selectAnthropicMessagesCountTokensModel,
      parseResultResponse('anthropicMessagesCountTokens', {
        needs: [],
        decode(bytes) {
          const parsed = parseJsonBody(bytes);
          return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
        },
        format: formatAnthropicError,
        noContent: null,
      }),
      kimiCodeDial('anthropicMessagesCountTokens', '/messages/count_tokens', formatAnthropicError),
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<KimiCodeServices, KimiCodeUpstream>);
