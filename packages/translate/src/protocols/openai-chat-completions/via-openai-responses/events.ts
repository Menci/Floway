import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import { readOpenAIResponsesEvents } from '../../openai-responses/as-target/events.ts';
import { writeOpenAIChatCompletionsEvents } from '../as-source/events.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  streamOptions: OpenAIChatCompletionsStreamOptionsEx,
  codec: SidecarCodec,
): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  const outputOptions = { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true };
  const stream = createRoundTripCoordinator('openaiChatCompletions', 'openaiResponses', codec);
  return writeOpenAIChatCompletionsEvents(readOpenAIResponsesEvents(frames, { roundTrip: stream.reader }), { ...outputOptions, roundTrip: stream.writer });
};
