import type { IRInputRequestHeader, IRInputToolSelector, IRInputTurn } from '../ir/input/types.ts';

export interface SourceCallIdentity extends IRInputToolSelector {
  readonly call_id?: string;
}

export interface RestoredAssistantTurn<Turn> {
  readonly kind: 'restored';
  readonly turn: Turn;
  readonly callIdentities: readonly SourceCallIdentity[];
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
 * `readCallIdentities` reads only naming facts for native replay, independently
 * of the conversion that would normalize or discard native residuals.
 *
 * `toIRInputTurns` is a thunk because the two paths are exclusive: a turn a sidecar
 * resolves is written natively, and its IR is never built.
 */
export type SourceTurnSlot<AssistantTurn> =
  | { readonly kind: 'client'; readonly toIRInputTurns: () => IRInputTurn[] }
  | {
    readonly kind: 'assistant';
    readonly assistantTurn: AssistantTurn;
    readonly readCallIdentities: () => readonly SourceCallIdentity[];
    readonly toIRInputTurns: () => IRInputTurn[];
  };

/**
 * A request read into what a writer consumes.
 *
 * The request's own prompt field opens `turns` when the protocol has one. It is
 * a client turn rather than a field of its own, which is what lets a writer
 * place it by position the same way it places every other turn.
 */
export interface SourceReading<AssistantTurn> {
  readonly request: IRInputRequestHeader;
  readonly turns: readonly SourceTurnSlot<AssistantTurn>[];
}

/**
 * Reads a conversation into the turns a writer consumes.
 *
 * The reading has already classified every turn, so this asks one question per
 * turn: can a sidecar state this one natively? If so its IR is never built —
 * the two paths are exclusive.
 */
export const resolveReading = async <AssistantTurn, Resolved>(
  reading: SourceReading<AssistantTurn>,
  resolve: (turn: Extract<SourceTurnSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<Resolved | undefined>,
): Promise<(IRInputTurn | RestoredAssistantTurn<Resolved>)[]> => {
  const turns: (IRInputTurn | RestoredAssistantTurn<Resolved>)[] = [];
  const append = (input: readonly IRInputTurn[]): void => {
    for (const turn of input) {
      const previous = turns.at(-1);
      // Prompts retain their own boundary for target-side hoisting. Other
      // adjacent client pieces belong to the same turn, including server
      // results followed by the client's next message.
      if (previous?.kind === 'client' && turn.kind === 'client'
        && !previous.items.some(item => item.type === 'prompt')
        && !turn.items.some(item => item.type === 'prompt')) {
        turns[turns.length - 1] = { kind: 'client', items: [...previous.items, ...turn.items] };
      } else {
        turns.push(turn);
      }
    }
  };
  for (const turn of reading.turns) {
    if (turn.kind === 'client') {
      append(turn.toIRInputTurns());
      continue;
    }
    const result = await resolve(turn);
    if (result === undefined) {
      append(turn.toIRInputTurns());
      continue;
    }
    turns.push({ kind: 'restored', turn: result, callIdentities: turn.readCallIdentities() });
  }
  return turns;
};
