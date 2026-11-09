import type { IRInputResolvedTurn } from './segments.ts';
import type { IRInputTurn } from './types.ts';
import type { IRInputLayout, IRInputSlot } from './layout.ts';

/** A call a resolved turn states, in the terms every protocol shares. */
export interface IRInputResolvedCall {
  readonly callId: string;
  readonly name: string;
}

/**
 * Reads an opened layout into the pieces a writer consumes.
 *
 * The layout has already classified every turn, so this asks one question per
 * slot: can a sidecar state this turn natively? If so the slot's IR is never
 * built — the two paths are exclusive — and the reader is told what the native
 * turn answered so its later turns still correlate.
 *
 * Nothing is held back between slots: a reader that must fold two source turns
 * into one does so while opening, where it can still see both.
 */
export const readIRInput = async <AssistantTurn, Resolved>(
  layout: IRInputLayout<AssistantTurn>,
  resolve: (slot: Extract<IRInputSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<
    { readonly resolved: Resolved; readonly calls?: readonly IRInputResolvedCall[] } | undefined
  >,
): Promise<(IRInputTurn | IRInputResolvedTurn<Resolved>)[]> => {
  const pieces: (IRInputTurn | IRInputResolvedTurn<Resolved>)[] = [];
  for (const slot of layout.slots) {
    if (slot.kind === 'client') {
      pieces.push(...slot.toIRTurn());
      continue;
    }
    const result = await resolve(slot);
    if (result === undefined) {
      pieces.push(...slot.toIRTurn());
      continue;
    }
    pieces.push({ kind: 'resolved', turn: result.resolved });
  }
  return pieces;
};
