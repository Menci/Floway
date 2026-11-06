import type { IRInputResolvedTurn } from './segments.ts';
import type { IRInputTurn } from './types.ts';

// A call a resolved turn states, described in the terms every protocol shares.
// A reader that correlates tool results against calls it has seen needs to know
// these already have answers; the route supplies them because only the route
// knows both the native turn and the reader.
export interface IRInputResolvedCall {
  readonly callId: string;
  readonly name: string;
}

/**
 * A source conversation presented for reading into the input IR.
 *
 * The reader owns everything protocol-specific about its own wire: how one
 * source turn becomes IR items, and what state reading one turn leaves for the
 * next. It knows nothing about where the IR is going — whether a turn can be
 * written natively instead is the caller's question, answered by `resolve`.
 */
export interface IRInputSource<Turn> {
  // A request's own top-level prompt field, which opens the conversation.
  readonly prompt: IRInputTurn | undefined;
  readonly conversation: readonly Turn[];
  turnToIR: (turn: Turn) => IRInputTurn[];
  // IR the reader must state ahead of a turn the caller wrote natively in place
  // of this source turn, because it belongs before that turn.
  observeResolvedTurn: (turn: Turn, calls: readonly IRInputResolvedCall[]) => IRInputTurn[];
  // IR the reader held back that no later source turn paired with.
  flush: () => IRInputTurn[];
}

/**
 * Reads a whole source conversation into the pieces a writer consumes.
 *
 * Driving the conversation here rather than in each route makes a reader's
 * held-back state impossible to forget: a reader that buffers a turn to pair it
 * with the next one has nowhere to leak it. Every session is therefore the same
 * shape — the prompt, then the turns, then whatever the reader still holds.
 *
 * `resolve` answers whether a source turn can be written natively in the target
 * protocol. Only a route can answer that, and only a route can say which calls
 * the resulting native turn states — a reader that correlates results against
 * calls needs them, and a reader that does not ignores them.
 */
export const readIRInput = async <Turn, Resolved>(
  source: IRInputSource<Turn>,
  resolve: (turn: Turn) => Promise<{ readonly resolved: Resolved; readonly calls?: readonly IRInputResolvedCall[] } | undefined>,
): Promise<(IRInputTurn | IRInputResolvedTurn<Resolved>)[]> => {
  const pieces: (IRInputTurn | IRInputResolvedTurn<Resolved>)[] = [];
  if (source.prompt !== undefined) pieces.push(source.prompt);
  for (const turn of source.conversation) {
    const result = await resolve(turn);
    if (result === undefined) {
      pieces.push(...source.turnToIR(turn));
      continue;
    }
    pieces.push(...source.observeResolvedTurn(turn, result.calls ?? []));
    pieces.push({ kind: 'resolved', turn: result.resolved });
  }
  pieces.push(...source.flush());
  return pieces;
};
