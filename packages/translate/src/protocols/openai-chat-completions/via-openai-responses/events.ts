import { irFromOpenAIResponses } from '../../openai-responses/as-target/sse-from.ts';
import { openaiChatCompletionsFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, streamOptions: OpenAIChatCompletionsStreamOptionsEx = {}): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> =>
  openaiChatCompletionsFromIR(irFromOpenAIResponses(frames), { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true });
