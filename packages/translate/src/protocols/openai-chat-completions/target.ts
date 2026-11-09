import { irInputToolsForChoice } from '../../ir/input/select-tools.ts';
import type { IRInputRequest } from '../../ir/input/types.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import { assignCallIds, type PendingCall } from '../../shared/call-ids.ts';
import { callIdentitiesOf, flattenRequestNames } from '../../shared/flatten-request.ts';
import type { TargetProtocol } from '../composition.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIChatCompletions } from './as-target/sse-from.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const freeformNames = (request: IRInputRequest): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

type ChatResolvedTurn = AssistantTurnFor<'openaiChatCompletions'>;

const callsOf = (turn: ChatResolvedTurn): readonly PendingCall[] => {
  if (turn.role !== 'assistant') return [];
  // The legacy `function_call` field is a call too, and a restored turn may
  // state it; it carries no id, so the result that answers it is matched by
  // name and a later id-less result takes whatever this turn allocated.
  const legacyCall = turn.function_call;
  const legacy = legacyCall == null ? [] : [{ callId: `legacy_${legacyCall.name}`, name: legacyCall.name }];
  return [
    ...legacy,
    ...(turn.tool_calls ?? []).map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
  ];
};

/**
 * Chat Completions written as the side a request goes to.
 *
 * Two facts only this side knows are needed to read its answer back: which
 * declarations it had to spell out, and which pair each flat name stands for.
 * Writing records both.
 */
export const openaiChatCompletionsTargetProtocol: TargetProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = {
  name: 'openaiChatCompletions',
  // This wire addresses a callable by one bare name, so every grouped
  // declaration and call is stated under the flat spelling it computes.
  write: (request, pieces) => {
    const flattened = flattenRequestNames(request, pieces);
    return Promise.resolve({
      payload: openaiChatCompletionsPayloadFromSegments(flattened.request, assignCallIds(flattened.pieces, callsOf), turn => turn),
      context: {
        // A freeform declaration reaches this wire as a function, so the reader
        // has to recognise the call that answers it as freeform again.
        customToolNames: freeformNames(request),
        // The upstream answers under the flat name it was asked with.
        callIdentities: callIdentitiesOf(request, pieces),
      },
    });
  },
  readStream: (frames, context, roundTripReader) =>
    irFromOpenAIChatCompletions(frames, { ...context, roundTrip: roundTripReader }),
};
