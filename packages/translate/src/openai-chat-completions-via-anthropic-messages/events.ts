import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromAnthropicMessages } from '../shared/ir/sse-from/anthropic-messages/index.ts';
import { openaiChatCompletionsFromIR } from '../shared/ir/sse-to/openai-chat-completions/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  streamOptions: OpenAIChatCompletionsStreamOptionsEx = {},
  codec?: AssistantTurnSidecarCodec,
): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  const outputOptions = { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true };
  if (codec === undefined) return openaiChatCompletionsFromIR(irFromAnthropicMessages(frames), outputOptions);
  const stream = createIRRoundTripStream('openaiChatCompletions', 'anthropicMessages', codec);
  return openaiChatCompletionsFromIR(irFromAnthropicMessages(frames, { roundTrip: stream.reader }), { ...outputOptions, roundTrip: stream.writer });
};
