// The pipeline's half of the dump: the record of a **whole run**.
//
// A run emits events — every stage, both directions — and this is where they
// go. What the runner hands `services.dump` is `sink`; what it accumulates is
// the encoded stream, folded event by event by `createRunEncoder` so a run is
// written down as it happens rather than re-walked at the end. At the terminal
// point the stream becomes NDJSON and one record goes through `DumpStore.put`,
// which is the same contract the edge record is written under: the stream is
// one more gzipped body file, retained and swept by the same row.
//
// Recording is conditional and that is structural: with no retention configured
// there is no sink to hand to `run`, so `services.dump` is absent and the
// runner does none of the recording — not a no-op that accumulates and throws
// the result away.

import { DumpAttribution, oneLineError, streamReadError } from './attribution.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import type { DumpMetadata } from './types.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createRunEncoder, toNdjson, type DumpEvent, type Event } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

// What the client sent, as the metadata needs it. The headers and the body are
// facts the run itself records, so nothing is snapshotted here beyond what a
// list row shows without opening the record.
interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly bodyByteLength: number;
  readonly streamError: string | null;
}

export class RunDump {
  private readonly attribution = new DumpAttribution();
  private readonly encode = createRunEncoder();
  private readonly events: DumpEvent[] = [];

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
  ) {}

  /** What the prologue hands to `run` as `services.dump`. Bound to this
   *  recording, so it travels as a value. */
  readonly sink = (event: Event): void => {
    for (const encoded of this.encode(event)) this.events.push(encoded);
  };

  // --- mid-flight hooks, the same four the edge record is stamped with ---

  requestedModel(model: string): void {
    this.attribution.requestedModel(model);
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.attribution.error(kind, upstream);
  }

  failed(reason: unknown): void {
    this.attribution.failed(reason);
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.attribution.success(identity, usage);
  }

  // --- terminal point ---

  // Two input shapes, matching the edge accumulator's seam:
  //
  //   • `(status, responseBytes)` — the caller already knows what it wrote.
  //   • `(response)` — tees the answer so the client gets bytes flowing while a
  //     background reader measures the other half. Only the byte count is kept:
  //     what the client was sent is already in the run's own record, so
  //     retaining a second copy of a streamed answer would buy nothing.
  //
  // The drain → encode → store put → broker publish runs on the runtime's
  // BackgroundScheduler so a dump write failure cannot turn a served answer
  // into a 502.
  finalize(status: number | null, responseBytes: number): void;
  finalize(response: Response): Response;
  finalize(...args: [number | null, number] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, responseBytes] = args;
      this.backgroundScheduler(this.write(status, responseBytes, null));
      return;
    }

    const [response] = args;
    if (response.body === null) {
      this.finalize(response.status, 0);
      return response;
    }

    const [forClient, forMeasure] = response.body.tee();
    this.backgroundScheduler((async () => {
      const reader = forMeasure.getReader();
      let payloadBytes = 0;
      let streamError: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          payloadBytes += value.byteLength;
        }
      } catch (err) {
        streamError = oneLineError(err);
      }
      await this.write(response.status, payloadBytes, streamError);
    })());

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async write(status: number | null, responseBytes: number, responseStreamError: string | null): Promise<void> {
    // ULID-from-completedAt keeps ids increasing with row creation time; the
    // random tail provides the deterministic tie-breaker for one millisecond.
    const completedAt = Date.now();
    const recordId = ulid(completedAt);
    const meta: DumpMetadata = await this.attribution.metadata({
      id: recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status,
      requestBytes: this.requestSnapshot.bodyByteLength,
      responseBytes,
      fallbackError: streamReadError(this.requestSnapshot.streamError, responseStreamError),
    });

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      await getDumpStore().put(this.apiKey.id, {
        shape: 'run',
        meta,
        events: new TextEncoder().encode(toNdjson(this.events)),
      });
      await getDumpBroker().publish(this.apiKey.id, meta);
    } catch (err) {
      console.error(`[dump] run write failed for key=${this.apiKey.id} record=${recordId}`, oneLineError(err));
    }
  }
}

/**
 * Returns null when the api key opts out of dumps, and the absence is the
 * mechanism: the prologue has nothing to put in `services.dump`, so the run
 * emits nothing and accumulates nothing.
 *
 * `method` and `path` are passed rather than read off a request so a transport
 * that carries several turns over one connection can name each one as what it
 * is — the same reason the edge accumulator takes its method explicitly.
 */
export const openRunDump = (
  apiKey: ApiKey,
  turn: { readonly method: string; readonly path: string; readonly body: RequestBody },
  backgroundScheduler: BackgroundScheduler,
): RunDump | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  return new RunDump(
    apiKey,
    {
      method: turn.method,
      path: turn.path,
      bodyByteLength: turn.body.bytes.byteLength,
      streamError: turn.body.streamError,
    },
    Date.now(),
    backgroundScheduler,
  );
};
