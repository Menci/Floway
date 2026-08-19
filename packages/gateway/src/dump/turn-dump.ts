// What a turn stamps on its recording, whichever shape that recording is.
//
// Two shapes are alive while the migration runs: the edge record, which holds what the client
// sent and what it got back, and the run record, which holds every stage of the pipeline as
// an event stream. The shape follows the endpoint — a pipelined one produces the run shape —
// and the stages in between neither know nor care which they are stamping.

import type { TokenUsage } from '../repo/types.ts';
import { isStreamFact, type StreamFact } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

/**
 * One stream, as the recording knows it.
 *
 * A run record identifies its streams, because their content arrives over time and after the
 * fact that holds them: the fact carries `{"$stream": n}` and the frames arrive afterwards
 * naming that id. `end` is what says the record of this stream is complete — a client that
 * stopped reading leaves it short, and the absence of the terminator is how a reader tells a
 * stream that ended from one that was cut off.
 *
 * The edge record has one frame log and no way to name anything in it, so its `fact` is null
 * and its terminator has nothing to write. That is the shape's limit rather than an omission,
 * and it goes away with the shape.
 */
export interface StreamRecording {
  frame(frame: ProtocolFrame<unknown>): void;
  end(): void;
  readonly fact: StreamFact | null;
}

export interface TurnDump {
  requestedModel(model: string): void;
  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void;
  error(kind: 'upstream' | 'gateway', upstream?: string): void;
  failed(reason: unknown): void;
  frame(frame: ProtocolFrame<unknown>): void;
  /** Begins recording one stream. Every call is a new one, which is what lets a turn that
   *  opens two — a sub-request beside the answer — keep them apart. */
  openStream(): StreamRecording;
  /** How much of the answer actually went out. A transport that writes its own frames counts
   *  them itself, because nothing downstream of it can. */
  recordSentPayloadBytes(byteLength: number): void;
  /** Closes the recording. A transport that owns its own response — the WebSocket turn —
   *  states what it sent; an HTTP one hands over the response so the bytes can be teed. */
  finalize(status: number | null, responseBytes: number | readonly unknown[]): void;
  finalize(response: Response): Response;
}

/**
 * Records a stream's frames as they are read, and hands them on untouched.
 *
 * What the record holds is the stream as the client is served it, so the tee goes outside
 * whatever shapes the frames and inside whatever frames them for a transport. For a family with
 * translated wires that is its edge and nowhere lower: below the edge the frames are the
 * upstream's and may still be another protocol's, above it they are transport frames the record
 * does not describe. A non-streaming turn folds the same frames into one value, and recording
 * here is what puts both in the record — the frames as they flowed beside the value assembled
 * from them.
 *
 * Reading is what records: a losing attempt nobody read contributes nothing, because the
 * release path drains the stream underneath this rather than through it, and a stream that
 * stopped short is recorded as far as it got.
 *
 * The value handed back *is* the stream reference, so the fact that holds it encodes as
 * `{"$stream": n}` and the frames that arrive afterwards say which stream they belong to.
 *
 * A record holds protocol frames, which is what most families' streams already carry. The
 * family whose stream is bare protocol events says how one becomes a frame, because the record
 * cannot guess and a cast would be it guessing.
 */
export function recordStream<T>(stream: AsyncIterable<ProtocolFrame<T>>, dump: TurnDump | null): AsyncIterable<ProtocolFrame<T>>;
export function recordStream<T>(stream: AsyncIterable<T>, dump: TurnDump | null, asFrame: (value: T) => ProtocolFrame<unknown>): AsyncIterable<T>;
export function recordStream<T>(
  stream: AsyncIterable<T>,
  dump: TurnDump | null,
  asFrame: (value: T) => ProtocolFrame<unknown> = value => value as ProtocolFrame<unknown>,
): AsyncIterable<T> {
  // No recording configured hands the same iterable back, so a record shows no step where
  // nothing happened and the stream is not wrapped for nobody.
  if (dump === null) return stream;

  const recording = dump.openStream();
  return {
    ...recording.fact,
    [Symbol.asyncIterator]: () => (async function* () {
      for await (const value of stream) {
        recording.frame(asFrame(value));
        yield value;
      }
      // Reached only where the source ran out on its own, which is what makes the record of
      // this stream complete. A reader that stopped early never gets here.
      recording.end();
    })(),
  };
}

/**
 * The reference a value carries to the stream the record holds, for a wrapper to carry across.
 *
 * A stream is framed again on its way out — protocol frames become SSE — and what the client
 * is handed is a different object over the same frames. Carrying the reference onto it is what
 * lets the fact that produced the stream and the fact that framed it point at one record.
 */
export const streamReferenceOf = (value: unknown): StreamFact | Record<string, never> =>
  isStreamFact(value) ? { ...value } : {};
