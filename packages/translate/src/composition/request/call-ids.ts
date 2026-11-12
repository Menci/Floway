import type { IRInputAssistantItem, IRInputClientMessageItem, IRInputCustomToolCallItem, IRInputFunctionCallItem, IRInputInstructionItem, IRInputToolResultItem, IRInputTurn } from '../../ir/input/types.ts';
import { TranslateInputException } from '../../shared/input-error.ts';
import type { RestoredAssistantTurn } from '../reading.ts';

// Target writers use this shape after allocating missing call IDs; every call and result has an ID.
export type IRInputTurnWithCallIds = IRInputClientTurnWithCallIds | IRInputAssistantTurnWithCallIds;
export interface IRInputClientTurnWithCallIds {
  readonly kind: 'client';
  readonly items: readonly IRInputClientItemWithCallIds[];
}
export interface IRInputAssistantTurnWithCallIds {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAssistantItemWithCallIds[];
}
export type IRInputClientItemWithCallIds = IRInputInstructionItem | IRInputClientMessageItem | IRInputToolResultItemWithCallId;
export type IRInputToolResultItemWithCallId = IRInputToolResultItem & { readonly call_id: string };
export type IRInputAssistantItemWithCallIds =
  | Exclude<IRInputAssistantItem, IRInputFunctionCallItem | IRInputCustomToolCallItem>
  | (IRInputFunctionCallItem & { readonly call_id: string })
  | (IRInputCustomToolCallItem & { readonly call_id: string });

export interface PendingCall {
  readonly name: string;
  readonly callId: string;
}

/**
 * Allocate missing IDs in conversation order so id-less results answer pending calls.
 * Explicit result IDs must refer to a call present in the conversation. Restored native
 * turns contribute their pending calls; target writers use the assigned IDs on calls and results.
 */
export const assignCallIds = <Restored>(
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
  restoredCalls: (turn: Restored) => readonly PendingCall[],
  resultCallIds?: ReadonlyMap<IRInputToolResultItem, string>,
): readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Restored>)[] => {
  const pending: PendingCall[] = [];
  let allocated = 0;
  // Every id this conversation states, read before allocating anything: an id
  // this step invents must not collide with one stated later in the same
  // conversation, or two calls would share it.
  const claimed = new Set<string>();
  for (const piece of turns) {
    if (piece.kind === 'restored') {
      for (const call of restoredCalls(piece.turn)) if (call.callId !== undefined) claimed.add(call.callId);
    } else if (piece.kind === 'assistant') {
      for (const item of piece.items) {
        if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id !== undefined) claimed.add(item.call_id);
      }
    }
  }
  const allocate = (name: string): string => {
    let candidate: string;
    do {
      allocated += 1;
      candidate = `${name}_call_${allocated}`;
    } while (claimed.has(candidate));
    claimed.add(candidate);
    return candidate;
  };
  // A stated answer releases the call it names; an unstated one takes the
  // oldest call of its name, or the oldest call at all when the source stated
  // no name either.
  const answer = (callId: string | undefined, name: string | undefined): PendingCall => {
    const index = callId !== undefined
      ? pending.findIndex(call => call.callId === callId)
      : name === undefined ? 0 : pending.findIndex(call => call.name === name);
    if (index < 0) {
      throw new TranslateInputException(callId === undefined
        ? `Cannot translate a tool result that answers no call${name === undefined ? ' (name: unstated)' : ` (name: ${name})`}.`
        : `Cannot translate a tool result answering '${callId}': no call of this conversation states that id.`);
    }
    const [answered] = pending.splice(index, 1);
    if (answered === undefined) throw new TranslateInputException('Cannot translate a tool result that answers no call.');
    return answered;
  };

  return turns.map((piece): IRInputTurnWithCallIds | RestoredAssistantTurn<Restored> => {
    if (piece.kind === 'restored') {
      pending.push(...restoredCalls(piece.turn));
      return piece;
    }
    if (piece.kind === 'client') {
      const items: IRInputClientItemWithCallIds[] = piece.items.map((item): IRInputClientItemWithCallIds => {
        if (item.type !== 'tool_result') return item;
        return { ...item, call_id: answer(resultCallIds?.get(item) ?? item.call_id, item.name).callId };
      });
      return { kind: 'client', items };
    }
    const items: IRInputAssistantItemWithCallIds[] = piece.items.map(item => {
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
      const callId = item.call_id ?? allocate(item.name);
      pending.push({ name: item.name, callId });
      return { ...item, call_id: callId };
    });
    return { kind: 'assistant', items };
  });
};
