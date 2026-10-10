import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { openaiChatCompletionsFromIR } from '../shared/ir/sse-to/openai-chat-completions/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  streamOptions: OpenAIChatCompletionsStreamOptionsEx = {},
  codec?: AssistantTurnSidecarCodec,
): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  const outputOptions = { continuousUsageStats: streamOptions.include_usage === true && streamOptions.continuous_usage_stats === true };
  if (codec === undefined) return openaiChatCompletionsFromIR(irFromOpenAIResponses(frames), outputOptions);
  const stream = createIRRoundTripStream('openaiChatCompletions', 'openaiResponses', codec);
  return openaiChatCompletionsFromIR(irFromOpenAIResponses(frames, { roundTrip: stream.reader }), { ...outputOptions, roundTrip: stream.writer });
};
