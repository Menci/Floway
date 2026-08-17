// What a turn stamps on its recording, whichever shape that recording is.
//
// Two shapes are alive while the migration runs: the edge record, which holds what the client
// sent and what it got back, and the run record, which holds every stage of the pipeline as
// an event stream. The shape follows the endpoint — a pipelined one produces the run shape —
// and the stages in between neither know nor care which they are stamping.

import type { TokenUsage } from '../repo/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export interface TurnDump {
  requestedModel(model: string): void;
  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void;
  error(kind: 'upstream' | 'gateway', upstream?: string): void;
  failed(reason: unknown): void;
  frame(frame: ProtocolFrame<unknown>): void;
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
 * What the record is to hold is the stream the client was actually served, so the tee belongs
 * at the family's edge: below it the frames are the upstream's and may still be translated,
 * above it they are transport frames the record does not describe. A non-streaming turn folds
 * the same frames into one value, and recording here is what puts both in the record — the
 * frames as they flowed beside the value assembled from them.
 *
 * Reading is what records: a losing branch nobody read contributes nothing, and a stream that
 * stopped short is recorded as far as it got.
 */
export const recordFrames = <T>(
  frames: AsyncIterable<ProtocolFrame<T>>,
  dump: TurnDump | null,
): AsyncIterable<ProtocolFrame<T>> => {
  // No recording configured hands the same iterable back, so a record shows no step where
  // nothing happened and the frames are not wrapped for nobody.
  if (dump === null) return frames;
  return {
    [Symbol.asyncIterator]: () => (async function* () {
      for await (const frame of frames) {
        dump.frame(frame);
        yield frame;
      }
    })(),
  };
};
