import type { IRInputRequest, IRInputTurn } from './types.ts';

/** A call a restored turn states, named the way the target named it. */
export interface IRInputPendingCall {
  readonly callId: string;
  readonly name: string;
}

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
  | { readonly kind: 'client'; readonly toIRTurn: RestoredCallsToIRTurn }
  | {
    readonly kind: 'assistant';
    readonly assistantTurn: AssistantTurn;
    readonly toIRTurn: RestoredCallsToIRTurn;
  };

/**
 * Builds a turn's IR, told which calls earlier turns left awaiting answers.
 *
 * A turn a sidecar restored is written natively and never passes through this
 * reader, but the calls it states are ones a later id-less result may answer.
 * Those calls reach the conversion as an argument rather than by the caller
 * reaching back into the reader's state: the reader that correlates them is
 * still the only code that knows how to, and the caller only reports what the
 * resolved turns stated.
 */
type RestoredCallsToIRTurn = (restored: readonly IRInputPendingCall[]) => IRInputTurn[];

/**
 * A request read into what a writer consumes.
 *
 * The request's own prompt field opens `turns` when the protocol has one. It is
 * a client turn rather than a field of its own, which is what lets a writer
 * place it by position the same way it places every other turn.
 */
export interface IRInputReading<AssistantTurn, Derived = undefined> {
  readonly request: IRInputRequest;
  readonly turns: readonly IRInputTurnSlot<AssistantTurn>[];
  /**
   * What reading had to accumulate for the client-side writer.
   *
   * Reading a request can produce values the writer still needs, and those are
   * built up as turns are read — a namespace map assigned in the order the
   * names appear, say — so they cannot be derived again from the request
   * afterwards. A protocol whose writer needs nothing states `undefined`.
   */
  readonly derived: Derived;
}

/**
 * Reads a conversation into the pieces a writer consumes.
 *
 * The reading has already classified every turn, so this asks one question per
 * turn: can a sidecar state this one natively? If so its IR is never built — the
 * two paths are exclusive — and the reader is told what the native turn answered
 * so its later turns still correlate.
 */
export const readTurns = async <AssistantTurn, Derived, Resolved>(
  reading: IRInputReading<AssistantTurn, Derived>,
  resolve: (turn: Extract<IRInputTurnSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<
    { readonly resolved: Resolved; readonly pendingCalls: readonly IRInputPendingCall[] } | undefined
  >,
): Promise<(IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[]> => {
  const pieces: (IRInputTurn | { readonly kind: 'resolved'; readonly turn: Resolved })[] = [];
  // What earlier resolved turns stated, in the order they were written. A
  // reader that correlates id-less results needs it and nothing else does.
  const restored: IRInputPendingCall[] = [];
  for (const turn of reading.turns) {
    if (turn.kind === 'client') {
      pieces.push(...turn.toIRTurn(restored));
      continue;
    }
    const result = await resolve(turn);
    if (result === undefined) {
      pieces.push(...turn.toIRTurn(restored));
      continue;
    }
    pieces.push({ kind: 'resolved', turn: result.resolved });
    restored.push(...result.pendingCalls);
  }
  return pieces;
};
