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
  /** The selected result for each legacy call, before modern matching. */
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
      for (const id of piece.synthesizedCallIds ?? []) if (id !== null) ids.add(id);
      continue;
    }
    for (const item of piece.items) {
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id !== undefined) ids.add(item.call_id);
    }
  }
  return ids;
};

/**
 * Native legacy `function_call` has no wire ID. When the sidecar carries a
 * synthesized call ID, it pairs with the first later result carrying that ID
 * (leaving the call pending if unanswered); otherwise it consumes the unique
 * later id-less result stating the same function name (where only a tail call
 * may remain pending), before modern calls consume the remaining results.
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

  const matchingResults = (
    start: number,
    stopsAt: (turn: RestoredAssistantTurn<Restored>) => boolean,
    matches: (item: IRInputToolResultItem) => boolean,
  ): IRInputToolResultItem[] => {
    const found: IRInputToolResultItem[] = [];
    for (let cursor = start; cursor < turns.length; cursor++) {
      const turn = turns[cursor];
      if (turn.kind === 'restored') {
        if (stopsAt(turn)) break;
        continue;
      }
      if (turn.kind !== 'client') continue;
      for (const item of turn.items) if (item.type === 'tool_result' && matches(item)) found.push(item);
    }
    return found;
  };

  for (const [index, piece] of turns.entries()) {
    if (piece.kind !== 'restored') continue;
    const name = piece.turn.function_call?.name;
    if (name === undefined) continue;
    const synthesizedId = piece.synthesizedCallIds?.[0];
    let answer: IRInputToolResultItem | undefined;
    if (synthesizedId != null) {
      [answer] = matchingResults(
        index + 1,
        turn => turn.synthesizedCallIds?.[0] === synthesizedId,
        item => item.call_id === synthesizedId,
      );
    } else {
      const candidates = matchingResults(
        index + 1,
        turn => turn.turn.function_call?.name === name,
        item => item.call_id === undefined && item.name === name,
      );
      if (candidates.length > 1) {
        throw new TranslateInputException(`Cannot translate the answer to the legacy call '${name}': ${candidates.length} id-less results state that function name.`);
      }
      [answer] = candidates;
      if (answer === undefined) {
        if (index < turns.length - 1) {
          throw new TranslateInputException(`Cannot translate the legacy call '${name}': no unique id-less result states that function name.`);
        }
        continue;
      }
    }
    let callId: string;
    do {
      allocated += 1;
      callId = `legacy_call_${allocated}`;
    } while (claimed.has(callId));
    claimed.add(callId);
    callIds.set(piece.turn, callId);
    names.set(callId, name);
    if (answer !== undefined) results.set(answer, callId);
  }
  return { callIds, names, results };
};
