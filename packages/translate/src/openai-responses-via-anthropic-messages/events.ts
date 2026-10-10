import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromAnthropicMessages } from '../shared/ir/sse-from/anthropic-messages/index.ts';
import { openaiResponsesFromIR } from '../shared/ir/sse-to/openai-responses/index.ts';
import type { NamespaceToolNames } from '../shared/openai-responses-via/namespace-tools.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, responseId: string, customToolNames: ReadonlySet<string> = new Set(), codec?: AssistantTurnSidecarCodec, namespaceToolNames?: NamespaceToolNames): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  if (codec === undefined) return openaiResponsesFromIR(irFromAnthropicMessages(frames, { customToolNames }), { id: responseId });
  const stream = createIRRoundTripStream('openaiResponses', 'anthropicMessages', codec);
  return openaiResponsesFromIR(irFromAnthropicMessages(frames, { customToolNames, roundTrip: stream.reader }), { id: responseId, namespaceToolNames, roundTrip: stream.writer });
};
