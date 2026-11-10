import type { IRInputTurn } from '../../ir/input/types.ts';

// A conversation translates in segments split at sidecar-resolved assistant
// turns. Those turns are already native target structure, so a writer emits
// them verbatim instead of reconstructing them from the IR.
//
// Segmentation is what preserves cross-turn behaviour: a writer that folds
// adjacent user turns into one native message must not fold across a resolved
// assistant turn, because that turn sits between them in the output.
export type Piece<Turn, InputTurn = IRInputTurn> = Segment<InputTurn> | ResolvedTurn<Turn>;

export interface Segment<InputTurn = IRInputTurn> {
  readonly kind: 'ir';
  readonly turns: readonly InputTurn[];
  // Only the first piece of a conversation may hoist a leading system run into
  // a protocol's top-level instructions slot.
  readonly leading: boolean;
}

export interface ResolvedTurn<Turn> {
  readonly kind: 'resolved';
  readonly turn: Turn;
}

export const segmentTurns = <Turn, InputTurn extends { readonly kind: 'client' | 'assistant' } = IRInputTurn>(pieces: readonly (InputTurn | ResolvedTurn<Turn>)[]): readonly Piece<Turn, InputTurn>[] => {
  const segments: (Segment<InputTurn> | ResolvedTurn<Turn>)[] = [];
  let current: InputTurn[] = [];
  let leading = true;
  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({ kind: 'ir', turns: current, leading });
    current = [];
    leading = false;
  };
  for (const piece of pieces) {
    if (piece.kind === 'resolved') {
      flush();
      leading = false;
      segments.push(piece);
      continue;
    }
    current.push(piece);
  }
  flush();
  return segments;
};
