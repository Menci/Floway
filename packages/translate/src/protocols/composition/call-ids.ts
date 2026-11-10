import type { ResolvedTurn } from './segments.ts';
import type { IRInputAddressedAssistantItem, IRInputAddressedClientItem, IRInputAddressedTurn } from '../../ir/input/addressed.ts';
import type { IRInputTurn } from '../../ir/input/types.ts';
import { TranslatorInputError } from '../../types.ts';

/** A call that has been stated and is still waiting for its result. */
export interface PendingCall {
  readonly name: string;
  readonly callId: string;
}

/**
 * States the call ids a target's wire requires.
 *
 * The input IR lets a source omit a call id: GenerateContent only states one
 * when the caller had it, and a conversation restored from a sidecar never
 * passed through the reading that would have seen it. Every translated target
 * nevertheless correlates a result to its call by id, so the ids are filled in
 * here — walking the conversation in order, which is what makes a result
 * without an id answer the call still awaiting one.
 *
 * A result that names an id this conversation does not hold is refused. It
 * answers a call the target never saw — a trimmed history, say — and the only
 * ways to write it would either pair it with the wrong call or state a call no
 * assistant turn made.
 *
 * This is a target's own concern: the ids it invents are its wire's spelling of
 * a call, and nothing outside this step reads them.
 */
export const assignCallIds = <Restored>(
  turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
  restoredCalls: (turn: Restored) => readonly PendingCall[],
): readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[] => {
  const pending: PendingCall[] = [];
  let allocated = 0;
  const allocate = (name: string): string => {
    allocated += 1;
    return `${name}_call_${allocated}`;
  };
  // A stated answer releases the call it names; an unstated one takes the
  // oldest call of its name, or the oldest call at all when the source stated
  // no name either.
  const answer = (callId: string | undefined, name: string | undefined): PendingCall => {
    const index = callId !== undefined
      ? pending.findIndex(call => call.callId === callId)
      : name === undefined ? 0 : pending.findIndex(call => call.name === name);
    if (index < 0) {
      throw new TranslatorInputError(callId === undefined
        ? `Cannot translate a tool result that answers no call${name === undefined ? ' (name: unstated)' : ` (name: ${name})`}.`
        : `Cannot translate a tool result answering '${callId}': no call of this conversation states that id.`);
    }
    const [answered] = pending.splice(index, 1);
    if (answered === undefined) throw new TranslatorInputError('Cannot translate a tool result that answers no call.');
    return answered;
  };

  return turns.map((piece): IRInputAddressedTurn | ResolvedTurn<Restored> => {
    if (piece.kind === 'resolved') {
      pending.push(...restoredCalls(piece.turn));
      return piece;
    }
    if (piece.kind === 'client') {
      const items: IRInputAddressedClientItem[] = piece.items.map((item): IRInputAddressedClientItem => {
        if (item.type !== 'tool_result') return item;
        return { ...item, call_id: answer(item.call_id, item.name).callId };
      });
      return { kind: 'client', items };
    }
    const items: IRInputAddressedAssistantItem[] = piece.items.map(item => {
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
      const callId = item.call_id ?? allocate(item.name);
      pending.push({ name: item.name, callId });
      return { ...item, call_id: callId };
    });
    return { kind: 'assistant', items };
  });
};
