import type { IRInputTurn } from '../../../ir/input/types.ts';
import type { InputAssistantTurnFor } from '../../../round-trip/assistant-turn.ts';
import { TranslatorInputError } from '../../../types.ts';
import type { ResolvedTurn } from '../../composition/segments.ts';

type ChatResolvedTurn = InputAssistantTurnFor<'openaiChatCompletions'>;

export interface ChatLegacyCalls {
  /**
   * The id the answer to each restored legacy call is written under, keyed by
   * that restored turn. Two calls may share a name, so the turn identifies one.
   */
  readonly callIds: ReadonlyMap<ChatResolvedTurn, string>;
  /** The legacy call each of those ids answers, by that id. */
  readonly names: ReadonlyMap<string, string>;
}

/** Every call id this conversation states, which no legacy answer can name. */
const statedCallIds = <Restored extends ChatResolvedTurn>(
  turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const piece of turns) {
    if (piece.kind === 'resolved') {
      for (const call of piece.turn.tool_calls ?? []) ids.add(call.id);
      continue;
    }
    for (const item of piece.items) {
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id !== undefined) ids.add(item.call_id);
    }
  }
  return ids;
};

/**
 * The id each restored legacy call's answer is written under.
 *
 * This wire has two ways to state a call. The modern one names an id, so its
 * answer names that id and pairing the two needs nothing here. The legacy
 * `function_call` names a call and states no id, and the sidecar carries that
 * turn back as the native message it was — so nothing in the conversation
 * records the id its answer should carry.
 *
 * Where that id exists, it is the one the answer itself states: the client's
 * wire invented it when the call reached it, so no turn of this conversation
 * holds it. It is found by elimination — inside the client turn that follows
 * the call, the answer is the one naming an id nothing here states. Where the
 * answer states no id either (a client whose own wire has no slot for one), the
 * pick falls to the ordering `assignCallIds` already applies, and the id this
 * returns only has to be one no wire will ever see.
 *
 * Two answers without a stated id cannot be told apart, and a call left
 * unanswered before the conversation moves on cannot be matched to a later
 * answer at all; both are refused. A call at the end of the conversation is
 * still simply awaiting its answer, which is not an error.
 */
export const chatLegacyCallsOf = <Restored extends ChatResolvedTurn>(
  turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
): ChatLegacyCalls => {
  const stated = statedCallIds(turns);
  const callIds = new Map<ChatResolvedTurn, string>();
  const names = new Map<string, string>();
  let allocated = 0;
  for (const [index, piece] of turns.entries()) {
    if (piece.kind !== 'resolved') continue;
    const name = piece.turn.role === 'assistant' ? piece.turn.function_call?.name : undefined;
    if (name === undefined) continue;
    const modern = new Set((piece.turn.tool_calls ?? []).map(call => call.id));
    const next = turns[index + 1];
    const results = next?.kind === 'client'
      ? next.items.flatMap(item => item.type === 'tool_result' ? [item] : [])
      : [];
    const unnamed = results.filter(item => item.call_id === undefined || (!stated.has(item.call_id) && !modern.has(item.call_id)));
    if (unnamed.length > 1) {
      throw new TranslatorInputError(`Cannot translate the answer to the legacy call '${name}': the turn after it states ${unnamed.length} results that name no call of this conversation, so nothing says which one answers it.`);
    }
    const [answer] = unnamed;
    if (answer === undefined) {
      // Only a conversation that moves past the call has missed its answer.
      if (index < turns.length - 1) {
        throw new TranslatorInputError(`Cannot translate the legacy call '${name}': the turn after it does not answer it, and a wire that states no id for the call cannot say which later answer means it.`);
      }
      continue;
    }
    // A result that states its own id answers under that id; one that states
    // none is answered by the ordering `assignCallIds` applies, so this id is
    // only the bookkeeping name for that pairing.
    allocated += 1;
    const callId = answer.call_id ?? `legacy_call_${allocated}`;
    callIds.set(piece.turn, callId);
    names.set(callId, name);
  }
  return { callIds, names };
};
