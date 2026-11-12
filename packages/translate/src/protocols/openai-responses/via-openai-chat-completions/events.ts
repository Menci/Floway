import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import { readOpenAIChatCompletionsEvents } from '../../openai-chat-completions/as-target/events.ts';
import { writeOpenAIResponsesEvents } from '../as-source/events.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, customToolNames: ReadonlySet<string>, codec: SidecarCodec, namespaceToolNames: NamespaceToolNames, maxChoices = 1): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  const stream = createRoundTripCoordinator('openaiResponses', 'openaiChatCompletions', codec);
  return writeOpenAIResponsesEvents(readOpenAIChatCompletionsEvents(frames, { customToolNames, maxChoices, roundTrip: stream.reader }), { namespaceToolNames, roundTrip: stream.writer });
};
