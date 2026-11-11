import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { readAnthropicMessagesEvents } from '../../anthropic-messages/as-target/events.ts';
import { writeOpenAIChatCompletionsEvents } from '../as-source/events.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  streamOptions: OpenAIChatCompletionsStreamOptionsEx,
  codec: SidecarCodec,
): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  const outputOptions = { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true };
  const stream = createRoundTripStream('openaiChatCompletions', 'anthropicMessages', codec);
  return writeOpenAIChatCompletionsEvents(readAnthropicMessagesEvents(frames, { roundTrip: stream.reader }), { ...outputOptions, roundTrip: stream.writer });
};
