import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { readAnthropicMessagesEvents } from '../../anthropic-messages/as-target/events.ts';
import { writeGeminiGenerateContentEvents } from '../as-source/events.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripCoordinator('geminiGenerateContent', 'anthropicMessages', codec);
  return writeGeminiGenerateContentEvents(readAnthropicMessagesEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
