import type { IRInputRequest, IRInputTurn } from './types.ts';

/** A call awaiting its result, named the way the target names it. */
export interface IRInputPendingCall {
  readonly callId: string;
  readonly name: string;
}

/**
 * One turn of a source conversation, already classified by the reader.
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
export type IRInputSlot<AssistantTurn> =
  | { readonly kind: 'client'; readonly toIRTurn: () => IRInputTurn[] }
  | {
      readonly kind: 'assistant';
      readonly assistantTurn: AssistantTurn;
      readonly toIRTurn: () => IRInputTurn[];
    };

/**
 * A source request opened into the slots its conversation states, in order.
 *
 * A request's own prompt field opens the layout when the protocol has one. It
 * is a client slot rather than a field of its own, which is what lets a writer
 * place it by position the same way it places every other turn.
 */
export interface IRInputLayoutBase<AssistantTurn> {
  readonly request: IRInputRequest;
  readonly slots: readonly IRInputSlot<AssistantTurn>[];
  /**
   * Registers the calls a restored turn leaves awaiting answers.
   *
   * Reading a conversation correlates id-less tool results against the calls it
   * has seen, and a turn a sidecar restores never passes through that reading.
   * The ids are the target's own, so they arrive with the restored turn rather
   * than from the source. A reader with no such correlation has nothing to do.
   */
  readonly observePendingCalls?: (pending: readonly IRInputPendingCall[]) => void;
}

/**
 * A request's reading, plus whatever deriving it produced for the writer.
 *
 * `Extra` is what the reading had to compute and the client-side writer still
 * needs — a snapshot of the caller's stream options, a flattened namespace map.
 * Its shape is the protocol's own, so nothing outside that protocol reads it. A
 * protocol that needs none states `undefined`, and then the field is absent.
 */
export type IRInputLayout<AssistantTurn, Extra = undefined> =
  [Extra] extends [undefined]
    ? IRInputLayoutBase<AssistantTurn>
    : IRInputLayoutBase<AssistantTurn> & { readonly extra: Extra };
