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
      for (const id of piece.sourceCallIds) if (id !== undefined) ids.add(id);
      continue;
    }
    for (const item of piece.items) {
      if ((item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_result') && item.call_id !== undefined) {
        ids.add(item.call_id);
      }
    }
  }
  return ids;
};

/**
 * Recovers the source-side call ID for a restored legacy `function_call` by
 * subtracting the turn's modern `tool_calls` wire IDs from the authenticated
 * source call IDs. Chat messages keep `function_call` and `tool_calls` on
 * separate fields without recording their relative stream order, so multiset
 * subtraction identifies the single legacy call regardless of order.
 */
const legacySourceCallId = <Restored extends ChatRestoredAssistantTurn>(
  piece: RestoredAssistantTurn<Restored>,
): string | undefined => {
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

/**
 * Native legacy `function_call` has no wire ID. When the authenticated source
 * turn assigned it a public call ID, it pairs FIFO with the first unconsumed
 * later result carrying that ID (leaving an unanswered call unregistered);
 * otherwise it consumes the unique unconsumed later id-less result stating the
 * same function name (where only a tail call may remain unanswered), before
 * modern calls consume the remaining results. Internal pairing IDs never change
 * the legacy wire's name-based result correlation.
 */
export const chatLegacyCallsOf = <Restored extends ChatRestoredAssistantTurn>(
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
): ChatLegacyCalls => {
  const claimed = new Set(statedCallIds(turns));
  const callIds = new Map<ChatRestoredAssistantTurn, string>();
  const names = new Map<string, string>();
  const results = new Map<IRInputToolResultItem, string>();
  const consumed = new Set<IRInputToolResultItem>();
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
      for (const item of turn.items) {
        if (item.type === 'tool_result' && !consumed.has(item) && matches(item)) found.push(item);
      }
    }
    return found;
  };

  for (const [index, piece] of turns.entries()) {
    if (piece.kind !== 'restored') continue;
    const name = piece.turn.function_call?.name;
    if (name === undefined) continue;
    const sourceCallId = legacySourceCallId(piece);
    let answer: IRInputToolResultItem | undefined;
    if (sourceCallId !== undefined) {
      [answer] = matchingResults(
        index + 1,
        () => false,
        item => item.call_id === sourceCallId,
      );
      if (answer === undefined) continue;
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
          throw new TranslateInputException(`Cannot translate the answer to the legacy call '${name}': no unique id-less result states that function name.`);
        }
        continue;
      }
    }
    consumed.add(answer);
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
