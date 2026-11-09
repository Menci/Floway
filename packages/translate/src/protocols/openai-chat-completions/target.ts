import type { TargetProtocol } from '../composition.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIChatCompletions } from './as-target/sse-from.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type ChatResolvedTurn = AssistantTurnFor<'openaiChatCompletions'>;

const callsOf = (turn: ChatResolvedTurn): readonly { callId: string; name: string }[] =>
  (turn.role === 'assistant' ? turn.tool_calls ?? [] : [])
    .map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name }));

/**
 * Chat Completions written as the side a request goes to.
 *
 * Reading a Chat stream needs the names of the request's freeform tools,
 * because Chat states one as a function and the reader has to recognise it
 * coming back. That is derived from the request, which is why the request is
 * handed to `readStream` as well as to `write`.
 */
export const openaiChatCompletionsTargetProtocol: TargetProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = {
  name: 'openaiChatCompletions',
  pendingCallIds: callsOf,
  write: (request, pieces) => Promise.resolve(openaiChatCompletionsPayloadFromSegments(request, pieces, turn => turn)),
  readStream: (frames, reader, _request, customToolNames) =>
    irFromOpenAIChatCompletions(frames, { customToolNames, roundTrip: reader }),
};
