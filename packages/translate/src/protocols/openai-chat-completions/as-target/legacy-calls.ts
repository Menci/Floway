import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import type { InputAssistantTurnFor } from '../../../round-trip/input-assistant-turn.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';

type ChatRestoredAssistantTurn = InputAssistantTurnFor<'openaiChatCompletions'>;

interface ChatLegacyCalls {
  /**
   * The id the answer to each restored legacy call is written under, keyed by
   * that restored turn. Two calls may share a name, so the turn identifies one.
   */
  readonly callIds: ReadonlyMap<ChatRestoredAssistantTurn, string>;
  /** The legacy call each of those ids answers, by that id. */
  readonly names: ReadonlyMap<string, string>;
}

/** Every call id this conversation states, which no legacy answer can name. */
const statedCallIds = <Restored extends ChatRestoredAssistantTurn>(
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const piece of turns) {
    if (piece.kind === 'restored') {
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
 * Native legacy function_call has no ID. Match its result within the following client turn by
 * eliminating stated modern call IDs; id-less results follow pending-call order.
 * Require one unambiguous answer before another round begins. A tail call may remain pending.
 * Internal pairing IDs never change the legacy wire's name-based result correlation.
 */
export const chatLegacyCallsOf = <Restored extends ChatRestoredAssistantTurn>(
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
): ChatLegacyCalls => {
  const stated = statedCallIds(turns);
  const claimed = new Set(stated);
  const callIds = new Map<ChatRestoredAssistantTurn, string>();
  const names = new Map<string, string>();
  let allocated = 0;
  for (const [index, piece] of turns.entries()) {
    if (piece.kind !== 'restored') continue;
    const name = piece.turn.function_call?.name;
    if (name === undefined) continue;
    const next = turns[index + 1];
    const results = next?.kind === 'client'
      ? next.items.flatMap(item => item.type === 'tool_result' ? [item] : [])
      : [];
    const unnamed = results.filter(item => item.call_id === undefined || !stated.has(item.call_id));
    if (unnamed.length > 1) {
      throw new TranslateInputException(`Cannot translate the answer to the legacy call '${name}': the turn after it states ${unnamed.length} results that name no call of this conversation, so nothing says which one answers it.`);
    }
    const [answer] = unnamed;
    if (answer === undefined) {
      if (index < turns.length - 1) {
        throw new TranslateInputException(`Cannot translate the legacy call '${name}': the turn after it does not answer it, and a wire that states no id for the call cannot say which later answer means it.`);
      }
      continue;
    }
    let callId = answer.call_id;
    if (callId === undefined) {
      do {
        allocated += 1;
        callId = `legacy_call_${allocated}`;
      } while (claimed.has(callId));
    }
    claimed.add(callId);
    callIds.set(piece.turn, callId);
    names.set(callId, name);
  }
  return { callIds, names };
};
