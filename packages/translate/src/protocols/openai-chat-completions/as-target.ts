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
  // The legacy `function_call` field is a call too. This wire states no id for
  // it, so the only id it has is the one the client's own history answers it
  // with — which is also the id the answer is written back under.
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

/**
 * Chat Completions written as the side a request goes to.
 *
 * Two facts only this side knows are needed to read its answer back: which
 * declarations it had to spell out, and which pair each flat name stands for.
 * Writing records both.
 */
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
      // Both facts come from the same flattening that produced the request, so
      // the reader sees exactly the names the upstream was asked with.
      context: flattened.context,
    };
  },
  readEvents: (frames, context, roundTripReader) =>
    readOpenAIChatCompletionsEvents(frames, { ...context, roundTrip: roundTripReader }),
};
