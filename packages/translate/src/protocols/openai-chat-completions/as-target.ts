import { readOpenAIChatCompletionsEvents } from './as-target/events.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type IRInputToolResultItemWithCallId, type PendingCall } from '../../composition/request/call-ids.ts';
import { allocateToolNames, type ToolNameContext } from '../../composition/request/tool-names.ts';
import type { InputAssistantTurnFor } from '../../round-trip/input-assistant-turn.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type ChatRestoredAssistantTurn = InputAssistantTurnFor<'openaiChatCompletions'>;

interface ChatRestoredCall extends PendingCall {
  readonly legacy?: true;
}

// Chat messages store `function_call` and `tool_calls` on separate fields
// without stream order; subtracting modern wire IDs as a multiset recovers the
// single legacy call's authenticated source ID regardless of order.
const legacySourceCallId = (piece: RestoredAssistantTurn<ChatRestoredAssistantTurn>): string | undefined => {
  const remainingModernIds = new Map<string, number>();
  for (const call of piece.turn.tool_calls ?? []) {
    remainingModernIds.set(call.id, (remainingModernIds.get(call.id) ?? 0) + 1);
  }
  const remaining: (string | undefined)[] = [];
  for (const id of piece.sourceCallIds) {
    if (id !== undefined) {
      const count = remainingModernIds.get(id) ?? 0;
      if (count > 0) {
        if (count === 1) remainingModernIds.delete(id);
        else remainingModernIds.set(id, count - 1);
        continue;
      }
    }
    remaining.push(id);
  }
  if (remainingModernIds.size > 0 || remaining.length !== 1) {
    throw new Error('Authenticated round-trip call IDs do not match restored Chat Completions tool calls');
  }
  return remaining[0];
};

const callsOf = (piece: RestoredAssistantTurn<ChatRestoredAssistantTurn>): readonly ChatRestoredCall[] => {
  const legacyCall = piece.turn.function_call;
  const legacyCallId = legacyCall == null ? undefined : legacySourceCallId(piece);
  return [
    ...(legacyCall == null ? [] : [{
      name: legacyCall.name,
      ...(legacyCallId === undefined ? {} : { callId: legacyCallId }),
      legacy: true as const,
    }]),
    ...(piece.turn.tool_calls ?? []).map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
  ];
};

/** Request name allocation records custom-call kinds and original logical identities for the event reader. */
export const openaiChatCompletionsTargetProtocol: TargetProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, ToolNameContext
> = {
  name: 'openaiChatCompletions',
  // This wire addresses a callable by one bare name, so every grouped
  // declaration and call is stated under the flat spelling it computes.
  write: (request, turns) => {
    const legacyResults = new Map<IRInputToolResultItemWithCallId, string>();
    const assigned = assignCallIds(turns, callsOf, {
      onMatch: (result, match) => {
        if (match.restored?.legacy) legacyResults.set(result, match.name);
      },
    });
    const flattened = allocateToolNames(request, assigned);
    return {
      payload: openaiChatCompletionsPayloadFromSegments(
        flattened.request,
        flattened.turns,
        legacyResults,
      ),
      context: flattened.context,
    };
  },
  readEvents: (frames, context, roundTripReader) =>
    readOpenAIChatCompletionsEvents(frames, { ...context, roundTrip: roundTripReader }),
};
