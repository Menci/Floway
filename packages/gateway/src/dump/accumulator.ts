import type { Context } from 'hono';

import { HttpCapture } from './http-capture.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import type {
  DumpErrorMeta,
  DumpMetadata,
  DumpStreamEvent,
  DumpUpstreamRef,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  StoredDumpResponseBody,
} from './types.ts';
import { encodeBodyForWire } from './wire.ts';
import { attemptTtftMs, type AttemptTiming } from '../data-plane/shared/attempt-timing.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProtocolError, TelemetryModelIdentity } from '@floway-dev/upstream';

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
  readonly rawCaptured: boolean;
  readonly bytes: Uint8Array;
  readonly payloadBytes: number;
  readonly streamError: string | null;
}

type HeaderLines = ReadonlyArray<readonly [string, string]>;
type StatusFinalization = [status: number, headers: HeaderLines, metadata?: Promise<void> | undefined];
type ResponseFinalization = [response: Response, metadata?: Promise<void> | undefined];

const isStatusFinalization = (args: StatusFinalization | ResponseFinalization): args is StatusFinalization => typeof args[0] === 'number';

// Anthropic-style disjoint per-category counts: input excludes cache reads
// and cache writes; sum the present ones onto the dump's single inputTokens
// column. Missing categories stay null (not measured) instead of zero so a
// recorded zero genuinely means "upstream said zero".
const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const { input, input_cache_read, input_cache_write } = usage;
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null;
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0);
};

const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => { pairs.push([name, value]); });
  return pairs;
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.kind, hue: upstream.hue };
};

export class DumpAccumulator {
  readonly http = new HttpCapture();
  private readonly events: DumpStreamEvent[] = [];
  private sentPayloadBytes = 0;
  private model: string | null = null;
  private upstreamId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorMeta: DumpErrorMeta | null = null;
  private readonly preparedRequestBody: Promise<PreparedDumpRequestBody>;
  // Pre-translation (target-protocol) view. Populated only on translated turns
  // via `executeTranslation`'s capture hook; stays empty on native turns.
  private readonly upstreamEvents: DumpStreamEvent[] = [];
  private readonly translatedErrors = new WeakMap<ProtocolError, () => void>();
  private upstreamTargetApi: ChatTargetApi | null = null;
  private upstreamApiErrorEnvelope: { status: number; headers: Array<[string, string]>; body: Uint8Array | null } | null = null;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    requestBody: Uint8Array,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
    private readonly wantsStream: boolean = false,
    private readonly timing: AttemptTiming = { upstreamCallStartedAt: null, firstOutputTokenAt: null },
  ) {
    this.preparedRequestBody = getDumpStore().prepareRequestBody(requestBody);
    // Preparation starts eagerly. Observe rejection until finalization awaits
    // the original promise through the background scheduler.
    void this.preparedRequestBody.catch(() => {});
  }

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  requestedModel(model: string): void {
    this.model = model;
  }

  firstOutput(startedAt: number): void {
    if (this.timing.firstOutputTokenAt !== null) return;
    this.timing.upstreamCallStartedAt = startedAt;
    this.timing.firstOutputTokenAt = performance.now();
  }

  stageUpstreamTranslationError(outcome: ProtocolError, capture: () => void): void {
    this.translatedErrors.set(outcome, capture);
  }

  selectUpstreamTranslationError(outcome: ProtocolError): void {
    const capture = this.translatedErrors.get(outcome);
    this.translatedErrors.delete(outcome);
    capture?.();
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.errorMeta = { kind };
    if (upstream !== undefined) this.upstreamId = upstream;
  }

  failed(reason: unknown): void {
    this.errorMeta = { kind: 'failed', reason: typeof reason === 'string' ? reason : oneLineError(reason) };
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame so
  // neither serialization nor parsing happens on this path; the dashboard
  // derives the SSE wire view on demand via the per-protocol
  // frame-to-SSE encoder + reducer.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events.push({ frame, ts: Date.now() - this.startedAt });
  }

  // --- pre-translation upstream hooks (called from `executeTranslation`) ---

  // Stamped eagerly at capture construction so `meta.targetApi` is set even
  // when the upstream stream produces zero frames (e.g. immediate done).
  setUpstreamTargetApi(api: ChatTargetApi): void {
    this.upstreamTargetApi = api;
  }

  // Records one ORIGINAL target-protocol frame, before Floway translates it
  // into the source protocol. Same shape as `frame()` so the dashboard renders
  // the upstream view with the same collected+events experience, dispatched
  // by `meta.targetApi` instead of `meta.path`.
  upstreamFrame(frame: ProtocolFrame<unknown>): void {
    this.upstreamEvents.push({ frame, ts: Date.now() - this.startedAt });
  }

  // Captures the verbatim upstream api-error envelope (status/headers/body)
  // BEFORE the optional `trip.apiError` rewrite. The bytes variant of the
  // upstream body; the dashboard renders it like any non-stream response body.
  upstreamApiError(error: { status: number; headers: Headers; body: Uint8Array | null }): void {
    this.upstreamApiErrorEnvelope = { status: error.status, headers: headerPairs(error.headers), body: error.body };
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength;
  }

  success(identity: Pick<TelemetryModelIdentity, 'model' | 'upstream'>, usage: TokenUsage | null): void {
    this.model = identity.model;
    this.upstreamId = identity.upstream;
    this.inputTokens = tokenUsageInput(usage);
    this.outputTokens = usage?.output ?? null;
  }

  // --- response-side: handler exit ---

  // Capture HTTP bytes on delivery so recording does not keep a canceled
  // client response alive. WebSocket callers have already sent their frames.
  finalize(status: number, headers: HeaderLines, metadata?: Promise<void>): void;
  finalize(response: Response, metadata?: Promise<void>): Response;
  finalize(...args: StatusFinalization | ResponseFinalization): void | Response {
    if (isStatusFinalization(args)) {
      const [status, headers, metadata] = args;
      this.backgroundScheduler(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        rawCaptured: this.requestSnapshot.method !== 'WS',
        bytes: new Uint8Array(),
        payloadBytes: this.sentPayloadBytes,
        streamError: null,
      }, metadata));
      return;
    }

    const [response, metadata] = args;
    const responseStatus = response.status;
    const responseHeaders = headerPairs(response.headers);

    if (response.body === null) {
      this.finalize(responseStatus, responseHeaders, metadata);
      return response;
    }

    const reader = response.body.getReader();
    const captured = Promise.withResolvers<string | null>();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let finished = false;
    const finish = (streamError: string | null): void => {
      finished = true;
      reader.releaseLock();
      captured.resolve(streamError);
    };
    const forClient = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const item = await reader.read();
          if (finished) return;
          if (item.done) {
            output.close();
            finish(null);
          } else {
            chunks.push(item.value.slice());
            total += item.value.byteLength;
            output.enqueue(item.value);
          }
        } catch (error) {
          if (finished) return;
          output.error(error);
          finish(oneLineError(error));
        }
      },
      async cancel(reason) {
        finished = true;
        try {
          await reader.cancel(reason);
        } finally {
          finish(reason === undefined ? 'Client canceled response' : oneLineError(reason));
        }
      },
    }, { highWaterMark: 0 });
    // The metadata dependency may reject before the captured body finishes.
    void metadata?.catch(() => undefined);
    this.backgroundScheduler((async () => {
      const streamError = await captured.promise;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      await this.write({
        status: responseStatus,
        headers: responseHeaders,
        rawCaptured: true,
        bytes,
        payloadBytes: bytes.byteLength,
        streamError,
      }, metadata);
    })());

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // --- private: persist ---

  private async write(response: ResponseSnapshot, metadata?: Promise<void>): Promise<void> {
    // ULID-from-completedAt keeps ids increasing with row creation time; the
    // random tail provides the deterministic tie-breaker for one millisecond.
    const completedAt = Date.now();
    const recordId = ulid(completedAt);
    await metadata;

    // Prefer the accumulator's frame log so dumps reflect the gateway's
    // frame sequence regardless of negotiated wire shape; passthrough
    // endpoints with no frames fall back to captured bytes.
    const responseBody: StoredDumpResponseBody = this.events.length > 0
      ? { type: 'stream', events: this.events }
      : response.bytes.byteLength > 0 || response.streamError !== null
        ? { type: 'bytes', body: response.bytes }
        : { type: 'none' };

    const ttftMs = this.wantsStream ? attemptTtftMs(this.timing) : null;

    const meta: DumpMetadata = {
      id: recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status: response.status,
      upstream: await resolveUpstreamRef(this.upstreamId ?? this.http.exchanges.at(-1)?.upstreamId ?? null),
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requestBytes: this.requestSnapshot.bodyByteLength,
      responseBytes: response.payloadBytes,
      durationMs: completedAt - this.startedAt,
      ttftMs,
      // Precedence: an explicit error stamp from the respond path wins;
      // otherwise a request-body read failure (operator-side payload didn't
      // arrive intact) outranks a response-body read failure. Both stream-
      // read failures surface as `kind: 'failed'`.
      error: this.errorMeta
        ?? (this.requestSnapshot.streamError !== null ? { kind: 'failed', reason: this.requestSnapshot.streamError } : null)
        ?? (response.streamError !== null ? { kind: 'failed', reason: response.streamError } : null),
      targetApi: this.upstreamTargetApi,
    };

    // Build the parallel pre-translation upstream body ONLY when upstream
    // data was captured. An empty upstream stream with no api-error means the
    // turn produced nothing to show (or was native) — omit the field so old
    // records and native turns share the same shape.
    const hasUpstream = this.upstreamEvents.length > 0 || this.upstreamApiErrorEnvelope !== null;
    const upstream = !hasUpstream ? undefined : {
      status: this.upstreamApiErrorEnvelope?.status ?? null,
      headers: this.upstreamApiErrorEnvelope?.headers ?? [],
      body: (this.upstreamApiErrorEnvelope === null
        ? { type: 'stream' as const, events: this.upstreamEvents }
        : this.upstreamApiErrorEnvelope.body === null
          ? { type: 'none' as const }
          : { type: 'bytes' as const, body: this.upstreamApiErrorEnvelope.body }) satisfies StoredDumpResponseBody,
    };

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    const record: DumpWriteRecord = {
      capture: {
        exchanges: this.http.exchanges,
        ...(response.rawCaptured ? {
          response: {
            body: encodeBodyForWire(response.bytes, response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''),
            complete: response.streamError === null,
            error: response.streamError,
          },
        } : {}),
      },
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
        ...(upstream !== undefined ? { upstream } : {}),
      },
    };
    await getDumpStore().put(this.apiKey.id, record);
    await getDumpBroker().publish(this.apiKey.id, meta);
  }
}

// Returns null when the api key opts out of dumps; callers then skip all
// per-request dump work. `method` is passed explicitly rather than read
// off the request so the WebSocket OpenAI Responses path can record each turn
// as `WS /v1/responses` rather than the upgrade's `GET`.
export const openDumpAccumulator = (
  c: Context,
  method: string,
  apiKey: ApiKey,
  requestBody: RequestBody,
  backgroundScheduler: BackgroundScheduler,
  wantsStream: boolean = false,
  timing?: AttemptTiming,
): DumpAccumulator | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const requestSnapshot: RequestSnapshot = {
    method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    bodyByteLength: requestBody.bytes.byteLength,
    streamError: requestBody.streamError,
  };
  return new DumpAccumulator(apiKey, requestSnapshot, requestBody.bytes, Date.now(), backgroundScheduler, wantsStream, timing);
};
