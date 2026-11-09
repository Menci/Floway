import type { IRInputRequest } from '../../ir/input/types.ts';
import { irInputToolsForChoice } from '../../ir/input/select-tools.ts';
import type { TargetProtocol } from '../composition.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIChatCompletions } from './as-target/sse-from.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';


/**
 * The names this target wrote as functions because it cannot state a freeform
 * declaration directly.
 *
 * Reading the stream back has to recognise those calls as freeform, and the
 * request is the only place that says which declarations were freeform.
 */
const wrappedFreeformNames = (request: IRInputRequest): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

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
  readStream: (frames, reader, request) =>
    irFromOpenAIChatCompletions(frames, { customToolNames: wrappedFreeformNames(request), roundTrip: reader }),
};
