import { getDumpBroker, getDumpStore } from './registry.ts';
import { dumpMetadataSchema } from './schemas.ts';
import { type DumpErrorMeta, type DumpLiveSummary, type DumpMetadata, dumpLiveStreamId } from './types.ts';
import type { CallRecordSummary } from '../data-plane/pipeline/call-metering.ts';
import type { HttpDelivery } from '../data-plane/pipeline/edge-http.ts';
import type { RenderOutcome } from '../data-plane/pipeline/render.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createDumpPump, type DumpCompletionSummary } from '@floway-dev/dump';
import type { HttpRequestFacts } from '@floway-dev/http';
import { Bytes, type ErrorSnapshot, type FactValue, isDeferred, isManagedStream, type RunEventSink, streamIdOf } from '@floway-dev/pipeline';
import { getLogStreamStore } from '@floway-dev/platform';

const oneLine = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
};

const inputTokens = (usage: TokenUsage | null | undefined): number | null => {
  if (usage === undefined || usage === null) return null;
  const values = [usage.input, usage.input_cache_read, usage.input_cache_write];
  return values.some(value => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
};

const settledValue = async <T>(value: FactValue): Promise<T | undefined> => {
  if (!isDeferred(value)) return undefined;
  const [result] = await Promise.allSettled([value.promise]);
  return result.status === 'fulfilled' ? result.value as T : undefined;
};

interface HostFailure {
  readonly status: number;
  readonly error: DumpErrorMeta;
}

interface LiveMetadata {
  readonly model: string | null;
  readonly status: number | undefined;
  readonly responseBytes: number;
  readonly uploadError: ErrorSnapshot | undefined;
  readonly hostFailure: HostFailure | undefined;
  readonly call: CallRecordSummary | undefined;
  readonly render: RenderOutcome | undefined;
  readonly delivery: HttpDelivery | undefined;
  readonly upstreamExchange: boolean;
}

const renderFailureMessages = {
  'protocol-error': 'Upstream SSE reported an error',
  'premature-eof': 'Upstream SSE ended before its terminal frame',
  'source-error': 'Upstream response rendering failed',
  'collect-error': 'Upstream response collection failed',
} satisfies Record<Extract<RenderOutcome, { kind: 'failed' }>['reason'], string>;

const dumpError = ({ status, call, uploadError, hostFailure, render, delivery, upstreamExchange }: LiveMetadata, summary: DumpCompletionSummary): DumpErrorMeta | null => {
  if (hostFailure !== undefined) return hostFailure.error;
  if (uploadError !== undefined) return { kind: 'failed', reason: oneLine(uploadError.message) };
  if (render?.kind === 'failed') return { kind: 'failed', reason: oneLine(render.error?.message ?? renderFailureMessages[render.reason]) };
  if (delivery?.kind === 'write-failed') return { kind: 'failed', reason: oneLine(delivery.error.message) };
  if (render?.kind === 'cancelled') return { kind: 'failed', reason: 'Downstream cancelled the SSE response' };
  const httpStatus = status ?? call?.status;
  if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) return { kind: call?.failed || upstreamExchange ? 'upstream' : 'gateway' };
  if (!summary.ok) {
    return { kind: 'failed', reason: summary.doneError?.message ?? 'Downstream response did not complete' };
  }
  return null;
};

const buildMetadata = async (started: DumpLiveSummary, values: LiveMetadata, summary: DumpCompletionSummary): Promise<DumpMetadata> => {
  const { call, hostFailure } = values;
  const completedAt = Date.now();
  const upstreamId = call?.upstreamId;
  const record = upstreamId == null ? null : await getRepo().upstreams.getById(upstreamId);
  const status = values.status ?? call?.status ?? (summary.ok ? 200 : 500);
  return dumpMetadataSchema.parse({
    ...started,
    completedAt,
    status: hostFailure?.status ?? status,
    upstream: record === null ? null : { id: record.id, name: record.name, kind: record.kind, hue: record.hue },
    model: call?.identity?.model ?? values.model ?? started.model,
    inputTokens: inputTokens(call?.tokenUsage),
    outputTokens: call?.tokenUsage?.output ?? null,
    responseBytes: values.responseBytes,
    durationMs: completedAt - started.startedAt,
    ttftMs: call?.firstOutputAt == null ? null : Math.round(call.firstOutputAt - call.upstreamStartedAt),
    error: dumpError(values, summary),
    targetApi: call?.targetApi ?? null,
    truncated: summary.truncated,
    droppedEvents: summary.droppedEvents,
  });
};

interface DumpSession {
  readonly recordId: string;
  readonly sink: RunEventSink;
  readonly completed: Promise<void>;
  readonly hostFailure: (error: unknown, status: number, upstream: boolean) => void;
}

export const openDumpSession = (apiKey: ApiKey, request: HttpRequestFacts, requestedModel?: string): DumpSession | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const { id: keyId } = apiKey;
  const startedAt = Date.now();
  const recordId = ulid(startedAt);
  let started: DumpLiveSummary = {
    id: recordId,
    startedAt,
    method: request.method,
    path: request.url.pathname,
    model: requestedModel ?? null,
    requestBytes: request.body instanceof Bytes ? request.body.byteLength : 0,
  };
  const store = getDumpStore();
  const broker = getDumpBroker();
  const artifactKey = store.createArtifactKey(keyId, startedAt, recordId);
  const reportFailure = (action: string, error: unknown) => console.error(`[dump] ${action} failed for key=${keyId} record=${recordId}`, oneLine(error));
  const live = getLogStreamStore().open(dumpLiveStreamId(keyId, recordId)).catch(error => {
    reportFailure('live stream open', error);
    return null;
  });
  let announced: Promise<void> | undefined;
  const announce = () => announced ??= live.then(() => broker.publish(keyId, { event: 'started', data: started }))
    .catch(error => reportFailure('broker start publish', error));

  const pump = createDumpPump({
    onLiveChunk: async (offset, bytes) => { await (await live)?.append(offset, bytes); },
    onLiveEnd: async () => { await (await live)?.end(); },
  });
  const written = store.stageAndPutArtifact(keyId, recordId, artifactKey, pump.artifact);
  void written.catch(error => pump.artifact.cancel(error).catch(() => undefined));

  let rootStageId: number | undefined;
  let responseStreamId: number | undefined;
  let responseBytes = 0;
  let status: number | undefined;
  let model: string | null = null;
  let uploadError: ErrorSnapshot | undefined;
  let hostFailure: HostFailure | undefined;
  let upstreamExchange = false;
  const baseChildren = new Map<number, number>();
  const pendingCalls = new Map<number, number>();
  const calls = new Map<number, CallRecordSummary>();
  let lastCall: CallRecordSummary | undefined;
  let render: Promise<RenderOutcome | undefined> | undefined;
  let delivery: Promise<HttpDelivery | undefined> | undefined;
  const sink: RunEventSink = event => {
    switch (event.k) {
    case 'enter': {
      const requested = event.facts['request.model'];
      if (model === null && typeof requested === 'string') model = requested;
      if (event.edge !== 'root') break;
      rootStageId = event.stageId;
      const http = event.facts['request.http'];
      if (http !== null && typeof http === 'object' && 'body' in http) {
        const body = http.body;
        if (body instanceof Bytes) started = { ...started, requestBytes: body.byteLength };
        if (body !== null && typeof body === 'object' && 'kind' in body && body.kind === 'upload-error' && 'error' in body) {
          uploadError = body.error as ErrorSnapshot;
        }
      }
      if (model !== null && started.model === null) started = { ...started, model };
      void announce();
      break;
    }
    case 'leave': {
      if (event.baseChildId !== undefined) baseChildren.set(event.stageId, event.baseChildId);
      if (event.stageId !== rootStageId) break;
      const http = event.facts['response.http'];
      if (http !== null && typeof http === 'object') {
        if ('status' in http && typeof http.status === 'number') status = http.status;
        if ('body' in http && http.body instanceof Bytes) responseBytes = http.body.byteLength;
        if ('body' in http && isManagedStream(http.body)) responseStreamId = streamIdOf(http.body);
        if ('exchange' in http && http.exchange === 'upstream') upstreamExchange = true;
      }
      render = settledValue<RenderOutcome>(event.facts['response.render']);
      delivery = settledValue<HttpDelivery>(event.facts['response.delivery']);
      break;
    }
    case 'deferred':
      if (event.name === 'call.record') pendingCalls.set(event.deferredId, event.stageId);
      break;
    case 'settled': {
      const stageId = pendingCalls.get(event.deferredId);
      if (stageId === undefined) break;
      pendingCalls.delete(event.deferredId);
      if (event.ok) {
        lastCall = event.value as CallRecordSummary;
        calls.set(stageId, lastCall);
      }
      break;
    }
    case 'frame': {
      if (event.streamId === responseStreamId && event.value instanceof Bytes) responseBytes += event.value.byteLength;
      break;
    }
    }
    pump.sink(event);
  };

  const completed = Promise.all([pump.completed, written]).then(async ([summary]) => {
    const [rendered, delivered] = await Promise.all([render, delivery]);
    let call: CallRecordSummary | undefined;
    for (let stageId = rootStageId; stageId !== undefined && call === undefined; stageId = baseChildren.get(stageId)) {
      call = calls.get(stageId);
    }
    const meta = await buildMetadata(started, {
      status, model, responseBytes, uploadError, hostFailure, upstreamExchange,
      call: call ?? lastCall, render: rendered, delivery: delivered,
    }, summary);
    await store.commitRecord(keyId, { meta, artifactKey });
    await announce();
    try {
      await broker.publish(keyId, { event: 'appended', data: meta });
    } catch (error) {
      reportFailure('broker publish', error);
    }
  }).catch(error => reportFailure('pipeline', error));

  return {
    recordId,
    sink,
    completed,
    hostFailure: (error, status, upstream) => {
      hostFailure = { status, error: upstream ? { kind: 'upstream' } : { kind: 'failed', reason: oneLine(error) } };
    },
  };
};
