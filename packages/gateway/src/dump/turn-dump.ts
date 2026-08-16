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
