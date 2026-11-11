import type { RestoredAssistantTurn } from '../composition/reading.ts';
import type { IRInputAssistantItem, IRInputCustomToolCallItem, IRInputFunctionCallItem, IRInputPromptItem, IRInputToolResultItem, IRInputUserMessageItem, IRInputTurn } from '../ir/input/types.ts';
import { TranslateInputException } from '../shared/input-error.ts';

// A conversation whose calls and results all state the call they answer.
//
// The input model leaves `call_id` optional because a source may not state one,
// but a target's wire correlates every result by id. A target fills the missing
// ones before writing, and this is the shape it holds afterwards — so a writer
// reads the id without re-checking what the filling already established.
export type IRInputTurnWithCallIds = IRInputClientTurnWithCallIds | IRInputAssistantTurnWithCallIds;
export interface IRInputClientTurnWithCallIds {
  readonly kind: 'client';
  readonly items: readonly IRInputClientItemWithCallIds[];
}
export interface IRInputAssistantTurnWithCallIds {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAssistantItemWithCallIds[];
}
export type IRInputClientItemWithCallIds = IRInputPromptItem | IRInputUserMessageItem | IRInputToolResultItemWithCallId;
export type IRInputToolResultItemWithCallId = IRInputToolResultItem & { readonly call_id: string };
export type IRInputAssistantItemWithCallIds =
  | Exclude<IRInputAssistantItem, IRInputFunctionCallItem | IRInputCustomToolCallItem>
  | (IRInputFunctionCallItem & { readonly call_id: string })
  | (IRInputCustomToolCallItem & { readonly call_id: string });

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
  turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
  restoredCalls: (turn: Restored) => readonly PendingCall[],
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
        return { ...item, call_id: answer(item.call_id, item.name).callId };
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
