import type { IRInputAddressedTurn } from '../../ir/input/types.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import { assignCallIds, type PendingCall } from '../../shared/call-ids.ts';
import { flattenRequestNames } from '../../shared/flatten-request.ts';
import type { ResolvedTurn } from '../composition/segments.ts';
import type { TargetProtocol } from '../composition.ts';
import { openaiChatCompletionsPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIChatCompletions } from './as-target/sse-from.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type ChatResolvedTurn = AssistantTurnFor<'openaiChatCompletions'>;

const callsOf = (turn: ChatResolvedTurn): readonly PendingCall[] => {
  if (turn.role !== 'assistant') return [];
  // The legacy `function_call` field is a call too, and a restored turn may
  // state it; it carries no id, so the result that answers it is matched by
  // name and a later id-less result takes whatever this turn allocated.
  const legacyCall = turn.function_call;
  const legacy = legacyCall == null ? [] : [{ callId: legacyCallId(legacyCall.name), name: legacyCall.name }];
  return [
    ...legacy,
    ...(turn.tool_calls ?? []).map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
  ];
};

/**
 * The id this writer gives a legacy `function_call`.
 *
 * That field states no id, but a result still has to name the call it answers.
 * The prefix keeps the invented id out of the way of a real one, and the map
 * this function feeds is what lets the result be written as the legacy `function`
 * message the field belongs with.
 */
const legacyCallId = (name: string): string => `legacy_call:${name}`;

/** Every legacy call this payload states, by the id the writer invented for it. */
const legacyCallsOf = (pieces: readonly (IRInputAddressedTurn | ResolvedTurn<ChatResolvedTurn>)[]): ReadonlyMap<string, string> => {
  const legacy = new Map<string, string>();
  for (const piece of pieces) {
    if (piece.kind !== 'resolved') continue;
    const name = piece.turn.role === 'assistant' ? piece.turn.function_call?.name : undefined;
    if (name !== undefined) legacy.set(legacyCallId(name), name);
  }
  return legacy;
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
    return {
      payload: openaiChatCompletionsPayloadFromSegments(
        flattened.request,
        assignCallIds(flattened.pieces, callsOf),
        turn => turn,
        legacyCallsOf(flattened.pieces as readonly (IRInputAddressedTurn | ResolvedTurn<ChatResolvedTurn>)[]),
      ),
      // Both facts come from the same flattening that produced the request, so
      // the reader sees exactly the names the upstream was asked with.
      context: flattened.context,
    };
  },
  readStream: (frames, context, roundTripReader) =>
    irFromOpenAIChatCompletions(frames, { ...context, roundTrip: roundTripReader }),
};
