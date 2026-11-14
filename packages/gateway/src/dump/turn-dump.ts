// What a turn stamps on its recording, whichever shape that recording is.
//
// Two shapes are alive while the migration runs: the edge record, which holds what the client
// sent and what it got back, and the run record, which holds every stage of the pipeline as
// an event stream. The shape follows the endpoint — a pipelined one produces the run shape —
// and the stages in between neither know nor care which they are stamping.

import type { HttpCapture } from './http-capture.ts';
import type { TokenUsage } from '../repo/types.ts';
import type { StreamFact } from '@floway-dev/pipeline';
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
  frame(frame: ProtocolFrame<unknown>): void | Promise<void>;
  end(): void | Promise<void>;
  readonly fact: StreamFact | null;
}

export interface TurnDump {
  readonly http?: HttpCapture;
  requestedModel(model: string): void;
  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void;
  error(kind: 'upstream' | 'gateway', upstream?: string): void;
  failed(reason: unknown, options?: { readonly fallback: boolean }): void;
  frame(frame: ProtocolFrame<unknown>): void | Promise<void>;
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
