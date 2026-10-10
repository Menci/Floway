import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromOpenAIChatCompletions } from '../shared/ir/sse-from/openai-chat-completions/index.ts';
import { anthropicMessagesFromIR } from '../shared/ir/sse-to/anthropic-messages/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, codec?: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  if (codec === undefined) return anthropicMessagesFromIR(irFromOpenAIChatCompletions(frames));
  const stream = createIRRoundTripStream('anthropicMessages', 'openaiChatCompletions', codec);
  return anthropicMessagesFromIR(irFromOpenAIChatCompletions(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
