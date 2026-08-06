// Per-request dump pipeline. Opens the dump session (request snapshot +
// opt-in decision) and exposes the mid-flight hooks the respond layer
// calls to record outcomes and frames. When the api key has no retention
// configured, opening returns null and the data plane pays no per-request
// cost.

import type { Context } from 'hono';

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
import type { OwnedRequestBody } from '../data-plane/shared/request-body.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isEventStreamMediaType, isMultipartFormDataMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';
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

interface DumpCaptureLimits {
  readonly requestBodyBytes: number;
  readonly multipartRequestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly streamEventBytes: number;
  readonly streamEvents: number;
}

// A dump is diagnostic data, so one request must not be able to retain an
// unbounded response beside the live delivery path. The full delivered byte
// count remains in metadata; bodies and canonical frames retain a useful
// prefix and surface an explicit capture failure when either ceiling is hit.
const DEFAULT_CAPTURE_LIMITS: DumpCaptureLimits = {
  requestBodyBytes: 8 * 1024 * 1024,
  multipartRequestBodyBytes: 1024 * 1024,
  responseBodyBytes: 8 * 1024 * 1024,
  streamEventBytes: 8 * 1024 * 1024,
  streamEvents: 10_000,
};

const assertCaptureLimit = (name: keyof DumpCaptureLimits, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Dump capture limit ${name} must be a non-negative safe integer`);
  }
};

class BoundedByteCapture {
  private buffer = new Uint8Array();
  private length = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0 || this.truncated) return;
    const accepted = Math.min(chunk.byteLength, this.limit - this.length);
    if (accepted > 0) {
      this.ensureCapacity(this.length + accepted);
      this.buffer.set(chunk.subarray(0, accepted), this.length);
      this.length += accepted;
    }
    if (accepted < chunk.byteLength) this.truncated = true;
  }

  clear(): void {
    this.buffer = new Uint8Array();
    this.length = 0;
    this.truncated = false;
  }

  take(): { bytes: Uint8Array; truncated: boolean } {
    const bytes = this.length === this.buffer.byteLength
      ? this.buffer
      : this.buffer.slice(0, this.length);
    const truncated = this.truncated;
    this.clear();
    return { bytes, truncated };
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.byteLength) return;
    const capacity = Math.min(
      this.limit,
      Math.max(required, Math.max(1024, this.buffer.byteLength * 2)),
    );
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}

// Four independent attribution slots the mid-flight hooks fill: `model` and
// `upstreamId` identify what the turn was about, `inputTokens` /
// `outputTokens` quantify what the upstream reported. They're independent
// because different outcomes set different subsets:
//
//   • Every protocol handler calls `requestedModel(model)` immediately after
//     parsing the payload, so `model` is set regardless of outcome.
//   • `success(identity, usage)` fills all four; the upstream-resolved model
//     id may overwrite what `requestedModel` had.
//   • `error(kind, upstream?)` records a categorized api-error envelope
//     (`kind` matches `ApiErrorResult.source`). Real upstream non-2xx pass
//     `upstream` so a 4xx/5xx row in the dashboard names the upstream that
//     rejected the call; the gateway arm may also pass it when a candidate
//     was already chosen (item-not-found rewrite, server-tool input
//     rejection).
//   • `failed(reason)` records an uncategorized terminal failure: a thrown
//     exception (caught by the respond layer or passthrough-serve), a
//     source-emitted error frame, a missing terminal event, or a writer error.
//     Caller passes a string or Error; the accumulator one-line-formats
//     it (`.message` only — never the stack, which lives in the response
//     body's debug envelope).
//
// `requestedModel`-set model survives across both error variants so even an
// outright-failed turn carries model attribution.

const sumTokenCategories = (
  usage: TokenUsage | null,
  keys: readonly Exclude<keyof TokenUsage, 'tier'>[],
): number | null => {
  if (!usage) return null;
  if (keys.every(key => usage[key] === undefined)) return null;
  return keys.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
};

// Protocol usage categories are disjoint. Collapse them onto the dump's two
// summary columns without losing cache-write tiers or image modalities.
const tokenUsageInput = (usage: TokenUsage | null): number | null =>
  sumTokenCategories(usage, ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image']);

const tokenUsageOutput = (usage: TokenUsage | null): number | null =>
  sumTokenCategories(usage, ['output', 'output_image']);

const oneLineError = (err: unknown): string => {
  let raw: string;
  try {
    raw = err instanceof Error ? String(err.message) : String(err);
  } catch {
    try {
      raw = Object.prototype.toString.call(err);
    } catch {
      raw = 'Unformattable error';
    }
  }
  const msg = raw.replace(/\s+/g, ' ').trim();
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

const jsonStringByteLength = (value: string): number => {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5C) bytes += 2;
    else if (code <= 0x1F) bytes += code === 0x08 || code === 0x09 || code === 0x0A || code === 0x0C || code === 0x0D ? 2 : 6;
    else if (code <= 0x7F) bytes += 1;
    else if (code <= 0x7FF) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xD800 && code <= 0xDFFF) bytes += 6;
    else bytes += 3;
  }
  return bytes;
};

const boundedJsonByteLength = (root: unknown, limit: number): number | null => {
  const visiting = new WeakSet<object>();
  const measure = (value: unknown, arrayValue = false): number => {
    if (value === null) return 4;
    switch (typeof value) {
    case 'string': return jsonStringByteLength(value);
    case 'boolean': return value ? 4 : 5;
    case 'number': return Number.isFinite(value) ? String(value).length : 4;
    case 'undefined':
    case 'function':
    case 'symbol': return arrayValue ? 4 : 0;
    case 'bigint': throw new TypeError('BigInt is not JSON-serializable');
    case 'object': break;
    }

    const object = value as object;
    if (visiting.has(object)) throw new TypeError('cyclic value is not JSON-serializable');
    visiting.add(object);
    try {
      if (Array.isArray(object)) {
        let bytes = 2;
        for (let index = 0; index < object.length; index++) {
          if (index > 0) bytes += 1;
          bytes += measure(object[index], true);
          if (bytes > limit) return bytes;
        }
        return bytes;
      }
      let bytes = 2;
      let fields = 0;
      for (const key in object) {
        if (!Object.hasOwn(object, key)) continue;
        const field = (object as Record<string, unknown>)[key];
        const fieldBytes = measure(field);
        if (fieldBytes === 0) continue;
        bytes += (fields === 0 ? 0 : 1) + jsonStringByteLength(key) + 1 + fieldBytes;
        fields += 1;
        if (bytes > limit) return bytes;
      }
      return bytes;
    } finally {
      visiting.delete(object);
    }
  };
  const bytes = measure(root);
  return bytes > limit ? null : bytes;
};

const cloneMeasuredJson = <T>(root: T): T => {
  const clones = new WeakMap<object, unknown>();
  const visiting = new WeakSet<object>();
  const clone = (value: unknown, arrayValue = false): unknown => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return arrayValue ? null : undefined;
      return value;
    }
    const existing = clones.get(value);
    if (visiting.has(value)) throw new TypeError('cyclic value is not JSON-serializable');
    if (existing !== undefined) return existing;
    visiting.add(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      clones.set(value, result);
      for (const item of value) result.push(clone(item, true));
      visiting.delete(value);
      return result;
    }
    const result: Record<string, unknown> = {};
    clones.set(value, result);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const field = clone((value as Record<string, unknown>)[key]);
      if (field !== undefined) result[key] = field;
    }
    visiting.delete(value);
    return result;
  };
  return clone(root) as T;
};

export class DumpAccumulator {
  private events: DumpStreamEvent[] = [];
  private capturedEventBytes = 2; // JSON array brackets written by the store.
  private eventCaptureStopped = false;
  private sawProtocolFrame = false;
  private captureClosed = false;
  private responseBodyCapture: BoundedByteCapture | null = null;
  private readonly captureFailures: string[] = [];
  private sentPayloadBytes = 0;
  private model: string | null = null;
  private upstreamId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorMeta: DumpErrorMeta | null = null;
  private readonly preparedRequestBody: Promise<PreparedDumpRequestBody>;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    requestBody: Uint8Array,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
    private readonly captureLimits: DumpCaptureLimits = DEFAULT_CAPTURE_LIMITS,
  ) {
    for (const [name, value] of Object.entries(captureLimits) as Array<[keyof DumpCaptureLimits, number]>) {
      assertCaptureLimit(name, value);
    }
    const contentType = requestSnapshot.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    const multipart = isMultipartFormDataMediaType(contentType);
    const requestCaptureLimit = multipart
      ? Math.min(captureLimits.requestBodyBytes, captureLimits.multipartRequestBodyBytes)
      : captureLimits.requestBodyBytes;
    const requestCapture = new BoundedByteCapture(requestCaptureLimit);
    requestCapture.append(requestBody);
    const capturedRequest = requestCapture.take();
    if (capturedRequest.truncated) {
      this.recordCaptureFailure(
        `Dump request body capture exceeded the ${requestCaptureLimit}-byte limit; stored body is truncated`,
      );
    }
    this.preparedRequestBody = getDumpStore().prepareRequestBody(capturedRequest.bytes, {
      compression: multipart ? 'identity' : 'adaptive',
    });
    // Preparation starts eagerly and is awaited at terminal persistence. Mark
    // a rejection handled immediately so a long upstream wait cannot surface
    // it as an unhandled promise before `write()` records the dump failure.
    void this.preparedRequestBody.catch(() => {});
  }

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  requestedModel(model: string): void {
    this.model = model;
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.errorMeta = { kind };
    if (upstream !== undefined) this.upstreamId = upstream;
  }

  failed(reason: unknown): void {
    this.errorMeta = { kind: 'failed', reason: oneLineError(reason) };
  }

  // Records one protocol frame. The bounded walker measures the JSON form
  // without materializing it, so an oversized image payload is rejected before
  // JSON.stringify can allocate another full copy.
  frame(frame: ProtocolFrame<unknown>): void {
    if (this.captureClosed) return;
    this.sawProtocolFrame = true;
    this.responseBodyCapture?.clear();
    if (this.eventCaptureStopped) return;

    const event = { frame, ts: Date.now() - this.startedAt };
    try {
      const delimiterBytes = this.events.length === 0 ? 0 : 1;
      const remainingBytes = this.captureLimits.streamEventBytes - this.capturedEventBytes - delimiterBytes;
      const eventBytes = boundedJsonByteLength(event, remainingBytes);
      if (
        this.events.length >= this.captureLimits.streamEvents
        || eventBytes === null
      ) {
        this.eventCaptureStopped = true;
        this.recordCaptureFailure(
          `Dump stream event capture truncated after ${this.events.length} events `
          + `(limits: ${this.captureLimits.streamEvents} events, ${this.captureLimits.streamEventBytes} bytes)`,
        );
        return;
      }
      this.events.push(cloneMeasuredJson(event) as DumpStreamEvent);
      this.capturedEventBytes += delimiterBytes + eventBytes;
    } catch (err) {
      this.eventCaptureStopped = true;
      this.recordCaptureFailure(`Dump stream event capture failed: ${oneLineError(err)}`);
    }
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength;
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.model = identity.model;
    this.upstreamId = identity.upstream;
    this.inputTokens = tokenUsageInput(usage);
    this.outputTokens = tokenUsageOutput(usage);
  }

  // --- response-side: handler exit ---

  // Schedules the dump-record write at the turn's terminal point. Two input
  // shapes:
  //
  //   • `(status, headers)` — no HTTP Response object to tee. The WebSocket
  //     Responses path uses this: its "response" is the stream of frames
  //     already captured via `frame()`, while the send seam records their
  //     actual UTF-8 payload bytes via `recordSentPayloadBytes()`.
  //   • `(response)` — wraps the original reader in one cancellation-coupled
  //     byte stream. Each client pull advances the source once, counts the
  //     delivered payload incrementally, and retains a bounded body prefix
  //     only when canonical protocol frames are unavailable. Client cancel
  //     reaches the original source directly and terminates the dump task.
  //     A null body falls through to the bare form.
  //
  // Terminal snapshot → record assembly → store put → broker publish is
  // scheduled through the runtime's BackgroundScheduler so dump write
  // failures cannot turn a successful upstream call into a 502.
  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void;
  finalize(response: Response): Response;
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, headers] = args;
      this.captureClosed = true;
      this.backgroundScheduler(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        isStream: this.sawProtocolFrame,
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
    const reader = response.body.getReader();
    const bodyCapture = new BoundedByteCapture(this.captureLimits.responseBodyBytes);
    this.responseBodyCapture = bodyCapture;
    if (this.sawProtocolFrame || isStream) bodyCapture.clear();

    let payloadBytes = 0;
    let terminated = false;
    let resolveSnapshot!: (snapshot: ResponseSnapshot) => void;
    const snapshot = new Promise<ResponseSnapshot>(resolve => { resolveSnapshot = resolve; });
    const terminate = (streamError: string | null): void => {
      if (terminated) return;
      terminated = true;
      this.captureClosed = true;
      this.responseBodyCapture = null;
      const captured = bodyCapture.take();
      const useCapturedBytes = !this.sawProtocolFrame && !isStream;
      const truncationError = captured.truncated && useCapturedBytes
        ? `Dump response body capture exceeded the ${this.captureLimits.responseBodyBytes}-byte limit; stored body is truncated`
        : null;
      resolveSnapshot({
        status: responseStatus,
        headers: responseHeaders,
        isStream,
        bytes: useCapturedBytes ? captured.bytes : new Uint8Array(),
        payloadBytes,
        streamError: [streamError, truncationError].filter((value): value is string => value !== null).join('; ') || null,
      });
    };

    const forClient = new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull: async controller => {
        try {
          for (;;) {
            const result = await reader.read();
            if (terminated) return;
            if (result.done) {
              controller.close();
              terminate(null);
              return;
            }
            const chunkBytes = result.value.byteLength;
            if (chunkBytes === 0) continue;
            if (!this.sawProtocolFrame && !isStream) {
              try {
                bodyCapture.append(result.value);
              } catch (err) {
                bodyCapture.clear();
                this.recordCaptureFailure(`Dump response body capture failed: ${oneLineError(err)}`);
              }
            }
            controller.enqueue(result.value);
            payloadBytes += chunkBytes;
            return;
          }
        } catch (err) {
          if (terminated) return;
          controller.error(err);
          terminate(`Response body stream failed: ${oneLineError(err)}`);
        }
      },
      cancel: reason => {
        const sourceCancellation = reader.cancel(reason);
        const canceled = reason === undefined
          ? 'Downstream response body canceled'
          : `Downstream response body canceled: ${oneLineError(reason)}`;
        terminate(canceled);
        return sourceCancellation;
      },
    });
    this.backgroundScheduler(snapshot.then(async captured => await this.write(captured)));

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
    const capturedEvents = this.events;
    this.events = [];
    const responseBody: StoredDumpResponseBody = this.sawProtocolFrame
      ? { type: 'stream', events: capturedEvents }
      : response.bytes.byteLength > 0 || response.streamError !== null
        ? response.isStream
          ? { type: 'stream', events: [] }
          : { type: 'bytes', body: response.bytes }
        : { type: 'none' };

    const baseError = this.errorMeta
      ?? (this.requestSnapshot.streamError !== null ? { kind: 'failed' as const, reason: this.requestSnapshot.streamError } : null);
    const captureFailures = [
      ...this.captureFailures,
      ...(response.streamError === null ? [] : [response.streamError]),
    ];
    const error: DumpErrorMeta | null = captureFailures.length === 0
      ? baseError
      : {
          kind: 'failed',
          reason: oneLineError([
            ...captureFailures,
            ...(baseError === null
              ? []
              : [baseError.kind === 'failed' ? baseError.reason : `${baseError.kind} error`]),
          ].join('; ')),
        };

    const meta: DumpMetadata = {
      id: recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status: response.status,
      upstream: await resolveUpstreamRef(this.upstreamId),
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requestBytes: this.requestSnapshot.bodyByteLength,
      responseBytes: response.payloadBytes,
      durationMs: completedAt - this.startedAt,
      // A capture failure must remain visible even when the respond path also
      // recorded an upstream/gateway outcome, so both are folded into one
      // failed reason rather than silently presenting a partial body as whole.
      error,
    };

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      const record: DumpWriteRecord = {
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

  private recordCaptureFailure(reason: string): void {
    if (!this.captureFailures.includes(reason)) this.captureFailures.push(reason);
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
  requestBody: OwnedRequestBody,
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
