// Per-request dump pipeline for an endpoint served by the onion: the record is
// the turn's two **edges** — what the client sent, what the client got back.
// Opens the dump session (request snapshot + opt-in decision) and exposes the
// mid-flight hooks the respond layer calls to record outcomes and frames. When
// the api key has no retention configured, opening returns null and the data
// plane pays no per-request cost.
//
// A pipelined endpoint records the whole run instead; `run-sink.ts` is that
// half, and both fill the same `DumpMetadata` through `DumpAttribution`.

import type { Context } from 'hono';

import { DumpAttribution, oneLineError } from './attribution.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import type {
  DumpErrorMeta,
  DumpMetadata,
  DumpStreamEvent,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  StoredDumpResponseBody,
} from './types.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isEventStreamMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

// Frozen at ctx construction so `finalize` never has to re-read a stream
// the handler already consumed.
interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyByteLength: number;
  readonly streamError: string | null;
}

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly isStream: boolean;
  readonly bytes: Uint8Array;
  readonly payloadBytes: number;
  readonly streamError: string | null;
}

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => { pairs.push([name, value]); });
  return pairs;
};

export class DumpAccumulator {
  private readonly attribution = new DumpAttribution();
  private readonly events: DumpStreamEvent[] = [];
  private sentPayloadBytes = 0;
  private readonly preparedRequestBody: Promise<PreparedDumpRequestBody>;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    requestBody: Uint8Array,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
  ) {
    this.preparedRequestBody = getDumpStore().prepareRequestBody(requestBody);
    // Preparation starts eagerly and is awaited at terminal persistence. Mark
    // a rejection handled immediately so a long upstream wait cannot surface
    // it as an unhandled promise before `write()` records the dump failure.
    void this.preparedRequestBody.catch(() => {});
  }

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  requestedModel(model: string): void {
    this.attribution.requestedModel(model);
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.attribution.error(kind, upstream);
  }

  failed(reason: unknown): void {
    this.attribution.failed(reason);
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame so
  // neither serialization nor parsing happens on this path; the dashboard
  // derives the SSE wire view on demand via the per-protocol
  // frame-to-SSE encoder + reducer.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events.push({ frame, ts: Date.now() - this.startedAt });
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength;
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.attribution.success(identity, usage);
  }

  // --- response-side: handler exit ---

  // Schedules the dump-record write at the turn's terminal point. Two input
  // shapes:
  //
  //   • `(status, headers)` — no HTTP Response object to tee. The WebSocket
  //     Responses path uses this: its "response" is the stream of frames
  //     already captured via `frame()`, while the send seam records their
  //     actual UTF-8 payload bytes via `recordSentPayloadBytes()`.
  //   • `(response)` — tees the response body so the client gets bytes
  //     flowing while a background reader accumulates the other half. The
  //     returned Response streams the client-side bytes; status, statusText,
  //     and headers pass through verbatim so the tee is invisible to the
  //     client. A null body falls through to the bare form.
  //
  // The background drain → record assembly → store put → broker publish is
  // scheduled through the runtime's BackgroundScheduler so dump write
  // failures cannot turn a successful upstream call into a 502.
  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void;
  finalize(response: Response): Response;
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, headers] = args;
      this.backgroundScheduler(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        isStream: this.events.length > 0,
        bytes: new Uint8Array(),
        payloadBytes: this.sentPayloadBytes,
        streamError: null,
      }));
      return;
    }

    const [response] = args;
    const responseStatus = response.status;
    const responseHeaders = headerPairs(response.headers);

    if (response.body === null) {
      this.finalize(responseStatus, responseHeaders);
      return response;
    }

    const isStream = isEventStreamMediaType(response.headers.get('content-type'));
    const [forClient, forCapture] = response.body.tee();
    this.backgroundScheduler((async () => {
      const reader = forCapture.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let streamError: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
      } catch (err) {
        streamError = oneLineError(err);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      await this.write({
        status: responseStatus,
        headers: responseHeaders,
        isStream,
        bytes,
        payloadBytes: bytes.byteLength,
        streamError,
      });
    })());

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // --- private: persist ---

  private async write(response: ResponseSnapshot): Promise<void> {
    // ULID-from-completedAt keeps ids increasing with row creation time; the
    // random tail provides the deterministic tie-breaker for one millisecond.
    const completedAt = Date.now();
    const recordId = ulid(completedAt);

    // Prefer the accumulator's frame log so dumps reflect the gateway's
    // frame sequence regardless of negotiated wire shape; passthrough
    // endpoints with no frames fall back to captured bytes.
    const responseBody: StoredDumpResponseBody = this.events.length > 0
      ? { type: 'stream', events: this.events }
      : response.bytes.byteLength > 0 || response.streamError !== null
        ? response.isStream
          ? { type: 'stream', events: [] }
          : { type: 'bytes', body: response.bytes }
        : { type: 'none' };

    const meta: DumpMetadata = await this.attribution.metadata({
      id: recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status: response.status,
      requestBytes: this.requestSnapshot.bodyByteLength,
      responseBytes: response.payloadBytes,
      // Precedence: an explicit error stamp from the respond path wins (the
      // assembler applies this only when there is none); otherwise a
      // request-body read failure (operator-side payload didn't arrive intact)
      // outranks a response-body read failure. Both stream-read failures
      // surface as `kind: 'failed'`.
      fallbackError: this.streamReadError(response),
    });

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      const record: DumpWriteRecord = {
        shape: 'edge',
        meta,
        request: {
          method: this.requestSnapshot.method,
          path: this.requestSnapshot.path,
          headers: this.requestSnapshot.headers.map(([k, v]) => [k, v]),
          body: await this.preparedRequestBody,
        },
        response: {
          status: response.status,
          headers: response.headers.map(([k, v]) => [k, v]),
          body: responseBody,
        },
      };
      await getDumpStore().put(this.apiKey.id, record);
      await getDumpBroker().publish(this.apiKey.id, meta);
    } catch (err) {
      console.error(`[dump] write failed for key=${this.apiKey.id} record=${recordId}`, oneLineError(err));
    }
  }

  private streamReadError(response: ResponseSnapshot): DumpErrorMeta | null {
    if (this.requestSnapshot.streamError !== null) return { kind: 'failed', reason: this.requestSnapshot.streamError };
    if (response.streamError !== null) return { kind: 'failed', reason: response.streamError };
    return null;
  }
}

// Returns null when the api key opts out of dumps; callers then skip all
// per-request dump work. `method` is passed explicitly rather than read
// off the request so the WebSocket Responses path can record each turn
// as `WS /v1/responses` rather than the upgrade's `GET`.
export const openDumpAccumulator = (
  c: Context,
  method: string,
  apiKey: ApiKey,
  requestBody: RequestBody,
  backgroundScheduler: BackgroundScheduler,
): DumpAccumulator | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const requestSnapshot: RequestSnapshot = {
    method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    bodyByteLength: requestBody.bytes.byteLength,
    streamError: requestBody.streamError,
  };
  return new DumpAccumulator(apiKey, requestSnapshot, requestBody.bytes, Date.now(), backgroundScheduler);
};
