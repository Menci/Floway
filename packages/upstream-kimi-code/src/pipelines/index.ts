import { dialAnthropicMessages } from './anthropic-messages/dial.ts';
import { dialAnthropicMessagesCountTokens } from './anthropic-messages-count-tokens/dial.ts';
import { compose, type KimiCodePipelineServices } from './facts.ts';
import { dialOpenAIChatCompletions } from './openai-chat-completions/dial.ts';
import { normalizeOpenAIChatCompletionsVendor } from './openai-chat-completions/normalize-vendor.ts';
import { dialOpenAIResponses } from './openai-responses/dial.ts';
import { normalizeOpenAIResponsesVendor } from './openai-responses/normalize-vendor.ts';
import { refreshProbes } from './refresh-probes.ts';
import { stripAnthropicMessagesHeaders, stripOpenAIHeaders } from './strip-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

interface KimiCodePipelines {
  openaiChatCompletions: UpstreamPipeline<'openaiChatCompletions', KimiCodePipelineServices, 'usageModelKey'>;
  openaiResponses: UpstreamPipeline<'openaiResponses', KimiCodePipelineServices, 'usageModelKey'>;
  anthropicMessages: UpstreamPipeline<'anthropicMessages', KimiCodePipelineServices, 'usageModelKey'>;
  anthropicMessagesCountTokens: UpstreamPipeline<'anthropicMessagesCountTokens', KimiCodePipelineServices, 'usageModelKey'>;
}

const commonEntry = ['http', 'upstream', 'model'] as const;

export const kimiCodePipelines: Readonly<KimiCodePipelines> = Object.freeze({
  openaiChatCompletions: compose('kimi-code.openaiChatCompletions', {
    entry: [...commonEntry, 'openaiChatCompletions'],
    exit: ['http', 'openaiChatCompletions', 'usageModelKey?'],
    stages: [stripOpenAIHeaders, normalizeOpenAIChatCompletionsVendor, dialOpenAIChatCompletions, refreshProbes],
    ending: httpTerminal,
  }),
  openaiResponses: compose('kimi-code.openaiResponses', {
    entry: [...commonEntry, 'openaiResponses'],
    exit: ['http', 'openaiResponses', 'usageModelKey?'],
    stages: [stripOpenAIHeaders, normalizeOpenAIResponsesVendor, dialOpenAIResponses, refreshProbes],
    ending: httpTerminal,
  }),
  anthropicMessages: compose('kimi-code.anthropicMessages', {
    entry: [...commonEntry, 'anthropicMessages'],
    exit: ['http', 'anthropicMessages', 'usageModelKey?'],
    stages: [stripAnthropicMessagesHeaders, dialAnthropicMessages, refreshProbes],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose('kimi-code.anthropicMessagesCountTokens', {
    entry: [...commonEntry, 'anthropicMessagesCountTokens'],
    exit: ['http', 'anthropicMessagesCountTokens', 'usageModelKey?'],
    stages: [stripAnthropicMessagesHeaders, dialAnthropicMessagesCountTokens],
    ending: httpTerminal,
  }),
});
