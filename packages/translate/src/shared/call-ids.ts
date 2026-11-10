import type { IRInputAddressedAssistantItem, IRInputAddressedClientItem, IRInputAddressedTurn, IRInputTurn } from '../ir/input/types.ts';
import type { ResolvedTurn } from '../protocols/composition/segments.ts';
import { TranslatorInputError } from '../types.ts';

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
 * This is a target's own concern: the ids it invents are its wire's spelling of
 * a call, and nothing outside this step reads them.
 */
export const assignCallIds = <Restored>(
  pieces: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
  restoredCalls: (turn: Restored) => readonly PendingCall[],
): readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[] => {
  const pending: PendingCall[] = [];
  let allocated = 0;
  const allocate = (name: string): string => {
    allocated += 1;
    return `${name}_call_${allocated}`;
  };
  // A result without an id answers the oldest call of its name, or the oldest
  // call at all when the source stated no name either.
  const takePending = (name: string | undefined): PendingCall => {
    const index = name === undefined ? 0 : pending.findIndex(call => call.name === name);
    if (index < 0) throw new TranslatorInputError(`Cannot translate a tool result naming '${name}': no call awaits it.`);
    const [matched] = pending.splice(index, 1);
    if (matched === undefined) throw new TranslatorInputError(`Cannot translate a tool result that answers no call (name: ${name ?? 'unstated'}).`);
    return matched;
  };

  return pieces.map((piece): IRInputAddressedTurn | ResolvedTurn<Restored> => {
    if (piece.kind === 'resolved') {
      pending.push(...restoredCalls(piece.turn));
      return piece;
    }
    if (piece.kind === 'client') {
      const items: IRInputAddressedClientItem[] = [];
      for (const item of piece.items) {
        if (item.type !== 'tool_result') {
          items.push(item);
          continue;
        }
        // A stated answer releases its call so a later id-less result cannot
        // take it.
        const stated = item.call_id;
        if (stated !== undefined) {
          const index = pending.findIndex(call => call.callId === stated);
          if (index >= 0) pending.splice(index, 1);
          items.push({ ...item, call_id: stated });
          continue;
        }
        items.push({ ...item, call_id: takePending(item.name).callId });
      }
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
