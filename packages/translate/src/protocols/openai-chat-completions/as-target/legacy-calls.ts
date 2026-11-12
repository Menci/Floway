import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputToolResultItem, IRInputTurn } from '../../../ir/input/types.ts';
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
  /** The selected id-less result for each legacy call, before modern matching. */
  readonly results: ReadonlyMap<IRInputToolResultItem, string>;
}

/** Every call id this conversation states, which an internal legacy pairing id must avoid. */
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
 * Native legacy function_call has no ID. It consumes the unique later id-less
 * result that states the same function name before modern calls consume the
 * remaining results. A tail call may remain pending.
 * Internal pairing IDs never change the legacy wire's name-based result correlation.
 */
export const chatLegacyCallsOf = <Restored extends ChatRestoredAssistantTurn>(
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
): ChatLegacyCalls => {
  const stated = statedCallIds(turns);
  const claimed = new Set(stated);
  const callIds = new Map<ChatRestoredAssistantTurn, string>();
  const names = new Map<string, string>();
  const results = new Map<IRInputToolResultItem, string>();
  let allocated = 0;
  for (const [index, piece] of turns.entries()) {
    if (piece.kind !== 'restored') continue;
    const name = piece.turn.function_call?.name;
    if (name === undefined) continue;
    const nextLegacyOffset = turns.slice(index + 1).findIndex(turn => turn.kind === 'restored' && turn.turn.function_call !== undefined);
    const end = nextLegacyOffset < 0 ? turns.length : index + 1 + nextLegacyOffset;
    const candidates = turns.slice(index + 1, end).flatMap(turn => turn.kind !== 'client' ? [] : turn.items.flatMap(item =>
      item.type === 'tool_result' && item.call_id === undefined && item.name === name ? [item] : []));
    if (candidates.length > 1) {
      throw new TranslateInputException(`Cannot translate the answer to the legacy call '${name}': ${candidates.length} id-less results state that function name.`);
    }
    const [answer] = candidates;
    if (answer === undefined) {
      if (index < turns.length - 1) {
        throw new TranslateInputException(`Cannot translate the legacy call '${name}': no unique id-less result states that function name.`);
      }
      continue;
    }
    let callId: string;
    do {
      allocated += 1;
      callId = `legacy_call_${allocated}`;
    } while (claimed.has(callId));
    claimed.add(callId);
    callIds.set(piece.turn, callId);
    names.set(callId, name);
    results.set(answer, callId);
  }
  return { callIds, names, results };
};
