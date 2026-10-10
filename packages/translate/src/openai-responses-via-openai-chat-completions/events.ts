import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromOpenAIChatCompletions } from '../shared/ir/sse-from/openai-chat-completions/index.ts';
import { openaiResponsesFromIR } from '../shared/ir/sse-to/openai-responses/index.ts';
import type { NamespaceToolNames } from '../shared/openai-responses-via/namespace-tools.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, customToolNames: ReadonlySet<string> = new Set(), codec?: AssistantTurnSidecarCodec, namespaceToolNames?: NamespaceToolNames): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  if (codec === undefined) return openaiResponsesFromIR(irFromOpenAIChatCompletions(frames, { customToolNames }));
  const stream = createIRRoundTripStream('openaiResponses', 'openaiChatCompletions', codec);
  return openaiResponsesFromIR(irFromOpenAIChatCompletions(frames, { customToolNames, roundTrip: stream.reader }), { namespaceToolNames, roundTrip: stream.writer });
};
