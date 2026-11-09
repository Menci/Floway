import type { IRInputRequest, IRInputTurn } from './types.ts';

/**
 * One turn of a source conversation, classified by the reader that produced it.
 *
 * A conversation turn states which side it belongs to; the reader keeps that
 * classification here instead of handing back an undifferentiated list for
 * every consumer to re-decide.
 *
 * An assistant turn also carries `assistantTurn`: the source's own structure
 * for it. A sidecar is computed over that structure — references and the turn
 * digest are material taken from it — so a resolved turn cannot be rebuilt from
 * the IR it would have produced.
 *
 * `toIRTurn` is a thunk because the two paths are exclusive: a turn a sidecar
 * resolves is written natively, and its IR is never built.
 */
export type IRInputTurnSlot<AssistantTurn> =
  | { readonly kind: 'client'; readonly toIRTurn: () => IRInputTurn[] }
  | {
    readonly kind: 'assistant';
    readonly assistantTurn: AssistantTurn;
    readonly toIRTurn: () => IRInputTurn[];
  };

/**
 * A request read into what a writer consumes.
 *
 * The request's own prompt field opens `turns` when the protocol has one. It is
 * a client turn rather than a field of its own, which is what lets a writer
 * place it by position the same way it places every other turn.
 */
export interface IRInputReading<AssistantTurn> {
  readonly request: IRInputRequest;
  readonly turns: readonly IRInputTurnSlot<AssistantTurn>[];
}

/**
 * Reads a conversation into the pieces a writer consumes.
 *
 * The reading has already classified every turn, so this asks one question per
 * turn: can a sidecar state this one natively? If so its IR is never built — the
 * two paths are exclusive — and the reader is told what the native turn answered
 * so its later turns still correlate.
 */
export const readTurns = async <AssistantTurn, Resolved>(
  reading: IRInputReading<AssistantTurn>,
  resolve: (turn: Extract<IRInputTurnSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<
    { readonly resolved: Resolved } | undefined
  >,
): Promise<(IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[]> => {
  const pieces: (IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[] = [];
  for (const turn of reading.turns) {
    if (turn.kind === 'client') {
      pieces.push(...turn.toIRTurn());
      continue;
    }
    const result = await resolve(turn);
    if (result === undefined) {
      pieces.push(...turn.toIRTurn());
      continue;
    }
    pieces.push({ kind: 'resolved', turn: result.resolved });
  }
  return pieces;
};
