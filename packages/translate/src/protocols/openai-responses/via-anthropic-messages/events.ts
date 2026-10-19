import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { irFromAnthropicMessages } from '../../anthropic-messages/as-target/sse-from.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { openaiResponsesFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, responseId: string, customToolNames: ReadonlySet<string>, codec: SidecarCodec, namespaceToolNames: NamespaceToolNames): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  const stream = createRoundTripStream('openaiResponses', 'anthropicMessages', codec);
  return openaiResponsesFromIR(irFromAnthropicMessages(frames, { customToolNames, roundTrip: stream.reader }), { id: responseId, namespaceToolNames, roundTrip: stream.writer });
};
