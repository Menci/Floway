import type { IRInputTurn } from './input.ts';

// A conversation translates in segments split at sidecar-resolved assistant
// turns. Those turns are already native target structure, so a writer emits
// them verbatim instead of reconstructing them from the IR.
//
// Segmentation is what preserves cross-turn behaviour: a writer that folds
// adjacent user turns into one native message must not fold across a resolved
// assistant turn, because that turn sits between them in the output.
export type IRInputPiece<Turn> = IRInputSegment | IRInputResolvedTurn<Turn>;

export interface IRInputSegment {
  readonly kind: 'ir';
  readonly turns: readonly IRInputTurn[];
  // Only the first piece of a conversation may hoist a leading system run into
  // a protocol's top-level instructions slot.
  readonly leading: boolean;
}

export interface IRInputResolvedTurn<Turn> {
  readonly kind: 'resolved';
  readonly turn: Turn;
}

export const segmentIRInput = <Turn>(pieces: readonly (IRInputTurn | IRInputResolvedTurn<Turn>)[]): readonly IRInputPiece<Turn>[] => {
  const segments: (IRInputSegment | IRInputResolvedTurn<Turn>)[] = [];
  let current: IRInputTurn[] = [];
  let leading = true;
  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({ kind: 'ir', turns: current, leading });
    current = [];
    leading = false;
  };
  for (const piece of pieces) {
    if ('kind' in piece && piece.kind === 'resolved') {
      flush();
      leading = false;
      segments.push(piece);
      continue;
    }
    current.push(piece as IRInputTurn);
  }
  flush();
  return segments;
};
