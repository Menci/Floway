import type { IRInputRequestHeader, IRInputTurn } from '../../ir/input/types.ts';

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
 * `toIRInputTurns` is a thunk because the two paths are exclusive: a turn a sidecar
 * resolves is written natively, and its IR is never built.
 */
export type TurnSlot<AssistantTurn> =
  | { readonly kind: 'client'; readonly toIRInputTurns: () => IRInputTurn[] }
  | {
    readonly kind: 'assistant';
    readonly assistantTurn: AssistantTurn;
    readonly toIRInputTurns: () => IRInputTurn[];
  };

/**
 * A request read into what a writer consumes.
 *
 * The request's own prompt field opens `turns` when the protocol has one. It is
 * a client turn rather than a field of its own, which is what lets a writer
 * place it by position the same way it places every other turn.
 */
export interface Reading<AssistantTurn> {
  readonly request: IRInputRequestHeader;
  readonly turns: readonly TurnSlot<AssistantTurn>[];
}

/**
 * Reads a conversation into the turns a writer consumes.
 *
 * The reading has already classified every turn, so this asks one question per
 * turn: can a sidecar state this one natively? If so its IR is never built —
 * the two paths are exclusive.
 */
export const resolveReading = async <AssistantTurn, Resolved>(
  reading: Reading<AssistantTurn>,
  resolve: (turn: Extract<TurnSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<
    { readonly resolved: Resolved } | undefined
  >,
): Promise<(IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[]> => {
  const turns: (IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[] = [];
  for (const turn of reading.turns) {
    if (turn.kind === 'client') {
      turns.push(...turn.toIRInputTurns());
      continue;
    }
    const result = await resolve(turn);
    if (result === undefined) {
      turns.push(...turn.toIRInputTurns());
      continue;
    }
    turns.push({ kind: 'resolved', turn: result.resolved });
  }
  return turns;
};
