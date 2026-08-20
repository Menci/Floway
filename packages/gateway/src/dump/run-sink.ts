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
import { createRunEncoder, isStreamFact, streamFact, toNdjson, type DumpEvent, type Event, type StreamFact } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
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
  private sentPayloadBytes = 0;
  private streams = 0;
  private answerStream: StreamRecording | undefined;

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

  // --- mid-flight hooks, the same ones the edge record is stamped with ---

  requestedModel(model: string): void {
    this.attribution.requestedModel(model);
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.attribution.error(kind, upstream);
  }

  failed(reason: unknown): void {
    this.attribution.failed(reason);
  }

  /**
   * A frame the client was sent, as the event the format names for one.
   *
   * The edge dump kept a frame log of its own; here a frame is content about a stream, so it
   * is `stream.frame` and it folds through the same encoder as everything else. A frame pushed
   * without opening a stream first belongs to the run's first one, which is what a transport
   * writing single synthesized frames alongside its answer is doing.
   */
  frame(frame: ProtocolFrame<unknown>): void {
    this.answerStream ??= this.openStream();
    this.answerStream.frame(frame);
  }

  /**
   * Begins recording one stream, under an id of its own.
   *
   * The id is what makes the frames resolvable: the fact holding the stream carries
   * `{"$stream": n}` and every frame event names the same `n`, so a run that opened two — a
   * sub-request's stream beside the answer's — keeps them apart. `end` says the record of that
   * stream is complete, and a client that stopped reading never reaches it.
   */
  openStream(): StreamRecording {
    const streamId = ++this.streams;
    return {
      frame: frame => { this.sink({ type: 'stream.frame', streamId, frames: [frame] }); },
      end: () => { this.sink({ type: 'stream.end', streamId }); },
      fact: streamFact(streamId),
    };
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.attribution.success(identity, usage);
  }

  /**
   * A record for a run this one started.
   *
   * A sub-request is an independent run — its own prologue, its own settlement — and its record
   * has to be its own too: a second run numbers its stages from 1 again, so its events landing
   * here would collide with this run's ids and the tree would read as one turn that entered the
   * same stage twice. Same key, same scheduler, so it is retained and swept by the same rule.
   */
  openSubRequest(turn: { readonly method: string; readonly path: string }): RunDump {
    return new RunDump(
      this.apiKey,
      { method: turn.method, path: turn.path, bodyByteLength: 0, streamError: null },
      Date.now(),
      this.backgroundScheduler,
    );
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
  /** A transport that writes its own frames counts what it sent, because nothing downstream
   *  of it can. The run's own bytes are its events; this is the answer's. */
  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength;
  }

  finalize(status: number | null, responseBytes: number): void;
  finalize(response: Response): Response;
  finalize(...args: [number | null, number] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, responseBytes] = args;
      // A transport that wrote its own frames counted them as it went; what it passes here
      // is whatever else it sent alongside them.
      this.backgroundScheduler(this.write(status, responseBytes + this.sentPayloadBytes, null));
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

/**
 * One stream, as the recording knows it.
 *
 * A record identifies its streams, because their content arrives over time and after the fact
 * that holds them: the fact carries `{"$stream": n}` and the frames arrive afterwards naming
 * that id. `end` is what says the record of this stream is complete — a client that stopped
 * reading leaves it short, and the absence of the terminator is how a reader tells a stream that
 * ended from one that was cut off.
 */
export interface StreamRecording {
  frame(frame: ProtocolFrame<unknown>): void;
  end(): void;
  readonly fact: StreamFact;
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
export function recordStream<T>(stream: AsyncIterable<ProtocolFrame<T>>, dump: RunDump | null): AsyncIterable<ProtocolFrame<T>>;
export function recordStream<T>(stream: AsyncIterable<T>, dump: RunDump | null, asFrame: (value: T) => ProtocolFrame<unknown>): AsyncIterable<T>;
export function recordStream<T>(
  stream: AsyncIterable<T>,
  dump: RunDump | null,
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
