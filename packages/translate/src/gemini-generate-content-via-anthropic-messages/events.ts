import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromAnthropicMessages } from '../shared/ir/sse-from/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../shared/ir/sse-to/gemini-generatecontent/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, codec?: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  if (codec === undefined) return geminiGenerateContentFromIR(irFromAnthropicMessages(frames));
  const stream = createIRRoundTripStream('geminiGenerateContent', 'anthropicMessages', codec);
  return geminiGenerateContentFromIR(irFromAnthropicMessages(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
