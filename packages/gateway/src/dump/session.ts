import type { Context } from 'hono';

import { getDumpBroker, getDumpStore } from './registry.ts';
import type {
  DumpErrorMeta,
  DumpLiveSummary,
  DumpMetadata,
  DumpUpstreamRef,
} from './types.ts';
import { dumpLiveStreamId } from './types.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHeaders } from '../data-plane/pipeline/index.ts';
import { attemptTtftMs, type AttemptTiming } from '../data-plane/shared/attempt-timing.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createDumpPump } from '@floway-dev/pipeline';
import type { DumpCompletionSummary, DumpPump, RawRunEvent, RunTraceSink } from '@floway-dev/pipeline';
import type { BackgroundScheduler, LogStream } from '@floway-dev/platform';
import { getLogStreamStore } from '@floway-dev/platform';
import type { ChatTargetApi, TelemetryModelIdentity } from '@floway-dev/provider';

interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  readonly streamError: string | null;
  readonly rawUrl: string;
}

const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const { input, input_cache_read, input_cache_write } = usage;
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null;
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0);
};

const oneLineError = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
};

const resolveUpstreamRef = async (
  repo: ReturnType<typeof getRepo>,
  id: string | null,
): Promise<DumpUpstreamRef | null> => {
  if (id === null) return null;
  const upstream = await repo.upstreams.getById(id);
  return upstream === null ? null : {
    id: upstream.id,
    name: upstream.name,
    kind: upstream.kind,
    hue: upstream.hue,
  };
};

const syntheticRun = (
  runId: string,
  startedAt: number,
  now: number,
): RawRunEvent => ({
  k: 'run',
  seq: 1,
  tMs: Math.max(0, now - startedAt),
  runId,
  pipelineName: 'gateway.pre-pipeline',
  startedAt,
});

const syntheticEnter = (
  startedAt: number,
  now: number,
  request: RequestSnapshot,
): RawRunEvent => ({
  k: 'enter',
  seq: 2,
  tMs: Math.max(0, now - startedAt),
  stageId: 1,
  parentStageId: null,
  edgeKind: 'root',
  name: 'gateway.edge',
  tap: 'downstream',
  facts: {
    'request.http': {
      method: request.method,
      url: buildDownstreamWireUrl(request.rawUrl),
      headers: inboundHeaderEntriesFromHeaders(new Headers(request.headers.map(([name, value]) => [name, value]))),
      body: { kind: 'raw', bytes: request.body },
    },
  },
});

const syntheticLeave = (
  startedAt: number,
  now: number,
  status: number,
  statusText: string,
  headers: Headers,
  responseBytes: Uint8Array,
): RawRunEvent => ({
  k: 'leave',
  seq: 3,
  tMs: Math.max(0, now - startedAt),
  stageId: 1,
  outcome: {
    status,
    statusText,
    headers: inboundHeaderEntriesFromHeaders(headers),
    body: responseBytes,
  },
});

const syntheticDone = (startedAt: number, now: number, status: number): RawRunEvent => ({
  k: 'done',
  seq: 4,
  tMs: Math.max(0, now - startedAt),
  ok: status < 400,
});

export class DumpSession {
  readonly traceSink: RunTraceSink;
  private readonly pump: DumpPump;
  private readonly releaseResponseLease: () => void;
  private readonly request: RequestSnapshot;
  private sawRunEvent = false;
  private model: string | null;
  private upstreamId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorMeta: DumpErrorMeta | null = null;
  private targetApi: ChatTargetApi | null = null;
  private responseStatus: number | null = null;
  private responseBytes = 0;
  private responseStreamError: string | null = null;
  private finalized = false;

  constructor(
    private readonly apiKey: ApiKey,
    method: string,
    request: RequestBody,
    requestHeaders: Headers,
    rawUrl: string,
    initialModel: string | undefined,
    private readonly startedAt: number,
    readonly recordId: string,
    readonly artifactKey: string,
    private readonly backgroundScheduler: BackgroundScheduler,
    private readonly wantsStream: boolean,
    private readonly timing?: AttemptTiming,
  ) {
    const model = initialModel ?? null;
    const requestSnapshot: RequestSnapshot = {
      method,
      path: new URL(rawUrl).pathname,
      headers: [...requestHeaders.entries()],
      body: request.bytes,
      streamError: request.streamError,
      rawUrl,
    };
    this.model = model;
    this.request = requestSnapshot;
    const store = getDumpStore();
    const broker = getDumpBroker();
    const repo = getRepo();
    const live = this.openLiveStream();
    let finalMetadata: DumpMetadata | null = null;
    this.pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      onLiveChunk: async (offset, bytes) => {
        const stream = await live;
        await stream?.append(offset, bytes);
      },
      onLiveEnd: async () => {
        const stream = await live;
        await stream?.end();
      },
      writeArtifact: stream => store.stageAndPutArtifact(
        this.apiKey.id,
        this.recordId,
        this.artifactKey,
        stream,
      ),
      commitMetadata: async summary => {
        finalMetadata = await this.buildMetadata(repo, summary);
        await store.commitRecord(this.apiKey.id, {
          meta: finalMetadata,
          artifactKey: this.artifactKey,
        });
      },
      onReady: async () => {
        if (finalMetadata === null) throw new Error('Dump completed without metadata');
        try {
          await broker.publish(this.apiKey.id, { event: 'appended', data: finalMetadata });
        } catch (error) {
          console.error(`[dump] broker publish failed for key=${this.apiKey.id} record=${this.recordId}`, oneLineError(error));
        }
      },
      waitUntil: promise => {
        backgroundScheduler(promise.catch(error => {
          console.error(`[dump] pipeline failed for key=${this.apiKey.id} record=${this.recordId}`, oneLineError(error));
        }));
      },
    });
    this.traceSink = {
      push: event => {
        if (event.k === 'run') this.sawRunEvent = true;
        this.pump.push(event);
      },
      registerSecretPlaintext: plaintext => this.pump.registerSecretPlaintext(plaintext),
      acquireProducerLease: () => this.pump.acquireProducerLease(),
    };
    this.releaseResponseLease = this.pump.acquireProducerLease();
    backgroundScheduler((async () => {
      const started: DumpLiveSummary = {
        id: this.recordId,
        startedAt: this.startedAt,
        method: requestSnapshot.method,
        path: requestSnapshot.path,
        model,
        requestBytes: requestSnapshot.body.byteLength,
      };
      try {
        await broker.publish(this.apiKey.id, { event: 'started', data: started });
      } catch (error) {
        console.error(`[dump] broker start publish failed for key=${this.apiKey.id} record=${this.recordId}`, oneLineError(error));
      }
    })());
  }

  requestedModel(model: string): void {
    this.model = model;
  }

  setUpstreamTargetApi(targetApi: ChatTargetApi): void {
    this.targetApi = targetApi;
  }

  error(kind: 'upstream' | 'gateway', upstreamId?: string): void {
    this.errorMeta = { kind };
    if (upstreamId !== undefined) this.upstreamId = upstreamId;
  }

  failed(reason: unknown): void {
    this.errorMeta = { kind: 'failed', reason: oneLineError(reason) };
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.model = identity.model;
    this.upstreamId = identity.upstream;
    this.inputTokens = tokenUsageInput(usage);
    this.outputTokens = usage?.output ?? null;
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.responseBytes += byteLength;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void;
  finalize(response: Response): Response;
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (this.finalized) {
      if (args.length === 1) return args[0];
      return;
    }
    if (args.length === 2) {
      this.finalized = true;
      const [status] = args;
      this.responseStatus = status;
      if (!this.sawRunEvent) {
        const responseHeaders = new Headers();
        for (const [name, value] of args[1]) responseHeaders.append(name, value);
        this.pushSyntheticRun(status, '', new Uint8Array(), responseHeaders);
      }
      this.releaseResponseLease();
      return;
    }

    const response = args[0];
    this.finalized = true;
    this.responseStatus = response.status;
    if (!this.sawRunEvent) {
      const [forClient, forCapture] = response.body === null ? [null, null] : response.body.tee();
      this.backgroundScheduler(this.captureSyntheticResponse(forCapture, response));
      return new Response(forClient, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (response.body === null) {
      this.releaseResponseLease();
      return response;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseResponseLease();
    };
    const reader = response.body.getReader();
    let stopped = false;
    const stop = async (reason?: unknown): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    };
    const counted = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          this.responseBytes += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          this.responseStreamError = oneLineError(error);
          await stop(error);
          controller.error(error);
        }
      },
      cancel: async reason => {
        await stop(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async captureSyntheticResponse(body: ReadableStream<Uint8Array> | null, response: Response): Promise<void> {
    let bytes = new Uint8Array();
    try {
      bytes = body === null ? bytes : new Uint8Array(await new Response(body).arrayBuffer());
    } catch (error) {
      this.responseStreamError = oneLineError(error);
    }
    this.pushSyntheticRun(response.status, response.statusText, bytes, response.headers);
    this.releaseResponseLease();
  }

  private pushSyntheticRun(status: number, statusText: string, responseBytes: Uint8Array, headers: Headers): void {
    this.responseBytes = responseBytes.byteLength;
    const now = Date.now();
    this.pump.push(syntheticRun(this.recordId, this.startedAt, now));
    this.pump.push(syntheticEnter(this.startedAt, now, this.request));
    this.pump.push(syntheticLeave(this.startedAt, now, status, statusText, headers, responseBytes));
    this.pump.push(syntheticDone(this.startedAt, now, status));
  }

  private async buildMetadata(repo: ReturnType<typeof getRepo>, summary: DumpCompletionSummary): Promise<DumpMetadata> {
    const completedAt = Date.now();
    const status = this.responseStatus ?? (summary.ok ? 200 : 500);
    return {
      id: this.recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.request.method,
      path: this.request.path,
      status,
      upstream: await resolveUpstreamRef(repo, this.upstreamId),
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requestBytes: this.request.body.byteLength,
      responseBytes: this.responseBytes,
      durationMs: completedAt - this.startedAt,
      ttftMs: this.wantsStream ? attemptTtftMs(this.timing) : null,
      error: this.errorMeta ?? (this.request.streamError === null ? null : { kind: 'failed', reason: this.request.streamError })
        ?? (this.responseStreamError === null ? null : { kind: 'failed', reason: this.responseStreamError }),
      targetApi: this.targetApi,
      truncated: summary.truncated,
      droppedEvents: summary.droppedEvents,
    };
  }

  private async openLiveStream(): Promise<LogStream | null> {
    try {
      return await getLogStreamStore().open(dumpLiveStreamId(this.apiKey.id, this.recordId));
    } catch (error) {
      console.error(`[dump] live stream open failed for key=${this.apiKey.id} record=${this.recordId}`, oneLineError(error));
      return null;
    }
  }

  async waitUntil(): Promise<void> {
    try {
      await this.pump.completion;
    } catch (error) {
      console.error(`[dump] pipeline failed for key=${this.apiKey.id} record=${this.recordId}`, oneLineError(error));
    }
  }
}

export const openDumpSession = (
  c: Context,
  method: string,
  apiKey: ApiKey,
  requestBody: RequestBody,
  backgroundScheduler: BackgroundScheduler,
  wantsStream: boolean,
  timing?: AttemptTiming,
  initialModel?: string,
): DumpSession | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const startedAt = Date.now();
  const recordId = ulid(startedAt);
  const artifactKey = getDumpStore().createArtifactKey(apiKey.id, startedAt, recordId);
  return new DumpSession(
    apiKey,
    method,
    requestBody,
    c.req.raw.headers,
    c.req.url,
    initialModel,
    startedAt,
    recordId,
    artifactKey,
    backgroundScheduler,
    wantsStream,
    timing,
  );
};
