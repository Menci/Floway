import { readOpenAIChatCompletionsEvents } from './as-target/events.ts';
import { chatLegacyCallsOf } from './as-target/legacy-calls.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import { assignCallIds, type PendingCall } from '../../request/call-ids.ts';
import { allocateToolNames, type ToolNameContext } from '../../request/tool-names.ts';
import type { InputAssistantTurnFor } from '../../round-trip/input-assistant-turn.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type ChatRestoredAssistantTurn = InputAssistantTurnFor<'openaiChatCompletions'>;

const callsOf = (
  turn: ChatRestoredAssistantTurn,
  legacyCallIds: ReadonlyMap<ChatRestoredAssistantTurn, string>,
): readonly PendingCall[] => {
  // Legacy calls have no wire ID. Track their results with the resolver's pairing ID;
  // the native function result still pairs by function name.
  const legacyCall = turn.function_call;
  const legacyId = legacyCallIds.get(turn);
  const legacy = legacyCall == null || legacyId === undefined
    ? []
    : [{ callId: legacyId, name: legacyCall.name }];
  return [
    ...legacy,
    ...(turn.tool_calls ?? []).map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
  ];
};

/** Request name allocation records custom-call kinds and original logical identities for the event reader. */
export const openaiChatCompletionsTargetProtocol: TargetProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, ToolNameContext
> = {
  name: 'openaiChatCompletions',
  // This wire addresses a callable by one bare name, so every grouped
  // declaration and call is stated under the flat spelling it computes.
  write: (request, turns) => {
    const flattened = allocateToolNames(request, turns, {
      ids: turn => [
        ...(turn.function_call == null ? [] : [undefined]),
        ...(turn.tool_calls ?? []).map(call => call.id),
      ],
      rename: (turn, names) => {
        let index = 0;
        return {
          ...turn,
          ...(turn.function_call == null ? {} : { function_call: { ...turn.function_call, name: names[index++]! } }),
          ...(turn.tool_calls === undefined ? {} : {
            tool_calls: turn.tool_calls.map(call => call.type === 'function'
              ? { ...call, function: { ...call.function, name: names[index++]! } }
              : { ...call, custom: { ...call.custom, name: names[index++]! } }),
          }),
        };
      },
    });
    const legacy = chatLegacyCallsOf(flattened.turns);
    return {
      payload: openaiChatCompletionsPayloadFromSegments(
        flattened.request,
        assignCallIds(flattened.turns, turn => callsOf(turn, legacy.callIds)),
        legacy.names,
      ),
      context: flattened.context,
    };
  },
  readEvents: (frames, context, roundTripReader) =>
    readOpenAIChatCompletionsEvents(frames, { ...context, roundTrip: roundTripReader }),
};
