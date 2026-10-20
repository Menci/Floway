import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { irFromOpenAIChatCompletions } from '../../openai-chat-completions/as-target/sse-from.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { openaiResponsesFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, customToolNames: ReadonlySet<string>, codec: SidecarCodec, namespaceToolNames: NamespaceToolNames, maxChoices = 1): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  const stream = createRoundTripStream('openaiResponses', 'openaiChatCompletions', codec);
  return openaiResponsesFromIR(irFromOpenAIChatCompletions(frames, { customToolNames, maxChoices, roundTrip: stream.reader }), { namespaceToolNames, roundTrip: stream.writer });
};
