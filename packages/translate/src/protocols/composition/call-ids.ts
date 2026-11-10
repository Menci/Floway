import type { ResolvedTurn } from './segments.ts';
import type { IRInputAddressedAssistantItem, IRInputAddressedClientItem, IRInputAddressedTurn } from '../../ir/input/addressed.ts';
import type { IRInputTurn } from '../../ir/input/types.ts';
import { TranslatorInputError } from '../../types.ts';

/**
 * A call that has been stated and is still waiting for its result.
 *
 * `callId` is absent for a call the wire stated without one: Chat Completions'
 * legacy `function_call` carries a name and nothing else. Such a call cannot be
 * named by any id, so it is answered by the one result of the turn that follows
 * which names no call this conversation holds.
 */
export interface PendingCall {
  readonly name: string;
  readonly callId?: string;
}

const describe = (call: PendingCall): string => call.callId === undefined ? `'${call.name}' (no id)` : `'${call.callId}'`;

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
 * A call the wire states without an id is the exception, and it is why the
 * rules below refuse rather than guess. Nothing can name such a call, so its
 * answer carries the call's name and no id; what tells that answer apart from
 * any other is that it names no call this conversation holds. That identifies
 * exactly one such call, answered in the turn right after the one that stated
 * it. A conversation outside that shape states an intent nothing can recover,
 * so it is refused instead of written as a request the upstream would reject.
 *
 * This is a target's own concern: the ids it invents are its wire's spelling of
 * a call, and nothing outside this step reads them.
 */
export const assignCallIds = <Restored>(
  turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
  restoredCalls: (turn: Restored) => readonly PendingCall[],
): readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[] => {
  // A call the wire gives no id also records the turn that stated it, which is
  // what bounds when its answer may arrive.
  const pending: (PendingCall & { readonly statedAt: number })[] = [];
  let allocated = 0;
  const allocate = (name: string): string => {
    allocated += 1;
    return `${name}_call_${allocated}`;
  };
  const release = (index: number): PendingCall & { readonly statedAt: number } => {
    const [released] = pending.splice(index, 1);
    if (released === undefined) throw new TranslatorInputError('Cannot translate a tool result that answers no call.');
    return released;
  };
  // An answer naming no held call may still answer a call this conversation
  // states no id for: the wire that put that call in front of the client had no
  // id to give it, so the client invented one no conversation ever states.
  const releaseUnnamed = (callId: string): PendingCall & { readonly statedAt: number } => {
    const unnamed = pending.flatMap((call, index) => call.callId === undefined ? [{ call, index }] : []);
    if (unnamed.length === 0) {
      throw new TranslatorInputError(`Cannot translate a tool result answering '${callId}': no call of this conversation states that id.`);
    }
    if (unnamed.length > 1) {
      throw new TranslatorInputError(`Cannot translate a tool result answering '${callId}': ${unnamed.length} calls await an answer without an id (${unnamed.map(({ call }) => `'${call.name}'`).join(', ')}), so nothing says which one it answers.`);
    }
    return release(unnamed[0]!.index);
  };

  const addressed: (IRInputAddressedTurn | ResolvedTurn<Restored>)[] = [];
  for (const [turnIndex, piece] of turns.entries()) {
    // A call no id names can only be answered by the turn right after the one
    // that stated it: a later turn has no way to say which call it means, and
    // two of them sharing a name would be told apart by nothing. A conversation
    // that ends on such a call is still awaiting its answer, so only reaching a
    // further turn proves it was missed.
    const missed = pending.filter(call => call.callId === undefined && turnIndex > call.statedAt + 1);
    if (missed.length > 0) {
      throw new TranslatorInputError(`Cannot translate a call stated without an id (${missed.map(describe).join(', ')}): the turn after it does not answer the call, and nothing later can say which call is meant.`);
    }

    if (piece.kind === 'resolved') {
      pending.push(...restoredCalls(piece.turn).map(call => ({ ...call, statedAt: turnIndex })));
      addressed.push(piece);
    } else if (piece.kind === 'assistant') {
      const items: IRInputAddressedAssistantItem[] = piece.items.map(item => {
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
        const callId = item.call_id ?? allocate(item.name);
        pending.push({ name: item.name, callId, statedAt: turnIndex });
        return { ...item, call_id: callId };
      });
      addressed.push({ kind: 'assistant', items });
    } else {
      const items: IRInputAddressedClientItem[] = piece.items.map((item): IRInputAddressedClientItem => {
        if (item.type !== 'tool_result') return item;
        let call: PendingCall;
        if (item.call_id !== undefined) {
          const index = pending.findIndex(held => held.callId === item.call_id);
          call = index >= 0 ? release(index) : releaseUnnamed(item.call_id);
        } else {
          // An unstated answer takes the oldest call of its name, or the oldest
          // call at all when the source stated no name either.
          const index = item.name === undefined ? 0 : pending.findIndex(held => held.name === item.name);
          if (index < 0) {
            throw new TranslatorInputError(`Cannot translate a tool result that answers no call${item.name === undefined ? ' (name: unstated)' : ` (name: ${item.name})`}.`);
          }
          call = release(index);
        }
        // The id stated here is the client's own: either it named the call with
        // it, or it is the one the client invented because the call had none.
        const callId = item.call_id ?? call.callId ?? allocate(call.name);
        return call.callId === undefined ? { ...item, call_id: callId, legacy_call_name: call.name } : { ...item, call_id: callId };
      });
      addressed.push({ kind: 'client', items });
    }
  }
  return addressed;
};
