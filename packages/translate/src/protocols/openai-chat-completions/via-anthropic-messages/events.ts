import type { AssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripStream } from '../../../round-trip/stream.ts';
import { irFromAnthropicMessages } from '../../anthropic-messages/as-target/sse-from.ts';
import { openaiChatCompletionsFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  streamOptions: OpenAIChatCompletionsStreamOptionsEx,
  codec: AssistantTurnSidecarCodec,
): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  const outputOptions = { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true };
  const stream = createRoundTripStream('openaiChatCompletions', 'anthropicMessages', codec);
  return openaiChatCompletionsFromIR(irFromAnthropicMessages(frames, { roundTrip: stream.reader }), { ...outputOptions, roundTrip: stream.writer });
};
