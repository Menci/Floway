import type { IRInputTurnWithCallIds } from '../ir/input/call-ids.ts';

// A conversation translates in segments split at sidecar-resolved assistant
// turns. Those turns are already native target structure, so a writer emits
// them verbatim instead of reconstructing them from the IR.
//
// Segmentation is what preserves cross-turn behaviour: a writer that folds
// adjacent user turns into one native message must not fold across a resolved
// assistant turn, because that turn sits between them in the output.
export interface Segment {
  readonly kind: 'ir';
  readonly turns: readonly IRInputTurnWithCallIds[];
  // Only the first segment of a conversation may hoist a leading system run into
  // a protocol's top-level instructions slot.
  readonly leading: boolean;
}

export interface RestoredAssistantTurn<Turn> {
  readonly kind: 'restored';
  readonly turn: Turn;
}

export const segmentTurns = <Turn>(turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Turn>)[]): readonly (Segment | RestoredAssistantTurn<Turn>)[] => {
  const segments: (Segment | RestoredAssistantTurn<Turn>)[] = [];
  let current: IRInputTurnWithCallIds[] = [];
  let leading = true;
  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({ kind: 'ir', turns: current, leading });
    current = [];
    leading = false;
  };
  for (const piece of turns) {
    if (piece.kind === 'restored') {
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
