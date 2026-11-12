import type { IRInputRequestHeader, IRInputToolSelector, IRInputTurn } from '../ir/input/types.ts';

export interface SourceCallIdentity extends IRInputToolSelector {
  readonly call_id?: string;
}

export interface RestoredAssistantTurn<Turn> {
  readonly kind: 'restored';
  readonly turn: Turn;
  readonly callIdentities: readonly SourceCallIdentity[];
}

/** Native turns authenticate sidecars; naming facts are read separately while restored turns bypass lazy IR conversion. */
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

export const resolveReading = async <AssistantTurn, Resolved>(
  reading: SourceReading<AssistantTurn>,
  resolve: (turn: Extract<SourceTurnSlot<AssistantTurn>, { kind: 'assistant' }>) => Promise<Resolved | undefined>,
): Promise<(IRInputTurn | RestoredAssistantTurn<Resolved>)[]> => {
  const turns: (IRInputTurn | RestoredAssistantTurn<Resolved>)[] = [];
  const append = (input: readonly IRInputTurn[]): void => {
    for (const turn of input) {
      const previous = turns.at(-1);
      // Instructions and system/developer messages retain their source boundaries. Other
      // adjacent client pieces belong to the same turn, including server
      // results followed by the client's next message.
      if (previous?.kind === 'client' && turn.kind === 'client'
        && !previous.items.some(item => item.type === 'instruction' || item.type === 'message' && item.role !== 'user')
        && !turn.items.some(item => item.type === 'instruction' || item.type === 'message' && item.role !== 'user')) {
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
