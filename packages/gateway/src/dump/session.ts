import { getDumpBroker, getDumpStore } from './registry.ts';
import { dumpMetadataSchema } from './schemas.ts';
import { type DumpErrorMeta, type DumpLiveSummary, type DumpMetadata, dumpLiveStreamId } from './types.ts';
import type { AnswerSource } from '../data-plane/pipeline/answer.ts';
import type { HttpDelivery } from '../data-plane/pipeline/edge-http.ts';
import type { RenderOutcome } from '../data-plane/pipeline/render.ts';
import type { Settlement } from '../data-plane/pipeline/settlement.ts';
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

interface FailedCandidate { readonly modelId: string; readonly upstreamId: string }

interface HostFailure {
  readonly status: number;
  readonly error: DumpErrorMeta;
  readonly candidate?: FailedCandidate;
}

interface LiveMetadata {
  readonly model: string | null;
  readonly status: number | undefined;
  readonly source: AnswerSource | undefined;
  readonly responseBytes: number;
  readonly uploadError: ErrorSnapshot | undefined;
  readonly hostFailure: HostFailure | undefined;
  readonly settlement: Settlement | undefined;
  readonly render: RenderOutcome | undefined;
  readonly delivery: HttpDelivery | undefined;
}

const renderFailureMessages = {
  'protocol-error': 'Upstream SSE reported an error',
  'premature-eof': 'Upstream SSE ended before its terminal frame',
  'source-error': 'Upstream response rendering failed',
  'collect-error': 'Upstream response collection failed',
} satisfies Record<Extract<RenderOutcome, { kind: 'failed' }>['reason'], string>;

const dumpError = ({ status, source, settlement, uploadError, hostFailure, render, delivery }: LiveMetadata, summary: DumpCompletionSummary): DumpErrorMeta | null => {
  if (hostFailure !== undefined) return hostFailure.error;
  if (uploadError !== undefined) return { kind: 'failed', reason: oneLine(uploadError.message) };
  if (render?.kind === 'failed') return { kind: 'failed', reason: oneLine(render.error?.message ?? renderFailureMessages[render.reason]) };
  if (delivery?.kind === 'write-failed') return { kind: 'failed', reason: oneLine(delivery.error.message) };
  if (render?.kind === 'cancelled') return { kind: 'failed', reason: 'Downstream cancelled the SSE response' };
  if (source !== undefined && status !== undefined && (status < 200 || status >= 300)) return { kind: source };
  if (!summary.ok || settlement?.outcome === 'failed') {
    return { kind: 'failed', reason: summary.doneError?.message ?? 'Downstream response did not complete' };
  }
  return null;
};

const buildMetadata = async (started: DumpLiveSummary, values: LiveMetadata, summary: DumpCompletionSummary): Promise<DumpMetadata> => {
  const { settlement, hostFailure } = values;
  const completedAt = Date.now();
  const upstreamId = settlement?.upstreamId ?? hostFailure?.candidate?.upstreamId;
  const record = upstreamId === undefined ? null : await getRepo().upstreams.getById(upstreamId);
  const outcome = settlement?.outcome;
  // WebSocket streaming turns have a request outcome in place of an HTTP
  // response status. Error envelopes carry their own status.
  const status = started.method === 'WS' && (outcome === 'success' || outcome === 'failed')
    ? outcome === 'success' ? 200 : 500
    : values.status ?? settlement?.status ?? (summary.ok ? 200 : 500);
  return dumpMetadataSchema.parse({
    ...started,
    completedAt,
    status: hostFailure?.status ?? status,
    upstream: record === null ? null : { id: record.id, name: record.name, kind: record.kind, hue: record.hue },
    model: settlement?.identity?.model ?? hostFailure?.candidate?.modelId ?? values.model ?? started.model,
    inputTokens: inputTokens(settlement?.tokenUsage),
    outputTokens: settlement?.tokenUsage?.output ?? null,
    responseBytes: values.responseBytes,
    durationMs: completedAt - started.startedAt,
    ttftMs: settlement?.firstOutputAt == null || settlement.upstreamStartedAt === null ? null : Math.round(settlement.firstOutputAt - settlement.upstreamStartedAt),
    error: dumpError(values, summary),
    targetApi: settlement?.targetApi ?? null,
    truncated: summary.truncated,
    droppedEvents: summary.droppedEvents,
  });
};

interface DumpSession {
  readonly recordId: string;
  readonly sink: RunEventSink;
  readonly completed: Promise<void>;
  readonly hostFailure: (error: unknown, status: number, upstream: boolean, candidate?: FailedCandidate) => void;
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
  let source: AnswerSource | undefined;
  let model: string | null = null;
  let uploadError: ErrorSnapshot | undefined;
  let hostFailure: HostFailure | undefined;
  let settlement: Promise<Settlement | undefined> | undefined;
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
      if (http !== null && typeof http === 'object' && 'body' in http && http.body instanceof Bytes) {
        started = { ...started, requestBytes: http.body.byteLength };
      }
      const error = event.facts['request.uploadError'];
      if (error !== undefined) uploadError = error as ErrorSnapshot;
      if (model !== null && started.model === null) started = { ...started, model };
      void announce();
      break;
    }
    case 'leave': {
      if (event.stageId !== rootStageId) break;
      const http = event.facts['response.http'];
      if (http !== null && typeof http === 'object') {
        if ('status' in http && typeof http.status === 'number') status = http.status;
        if ('body' in http && http.body instanceof Bytes) responseBytes = http.body.byteLength;
        if ('body' in http && isManagedStream(http.body)) responseStreamId = streamIdOf(http.body);
      }
      const answerSource = event.facts['response.source'];
      if (answerSource === 'upstream' || answerSource === 'gateway') source = answerSource;
      settlement = settledValue<Settlement>(event.facts['response.settlement']);
      render = settledValue<RenderOutcome>(event.facts['response.render']);
      delivery = settledValue<HttpDelivery>(event.facts['response.delivery']);
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
    const [settled, rendered, delivered] = await Promise.all([settlement, render, delivery]);
    const meta = await buildMetadata(started, {
      status, source, model, responseBytes, uploadError, hostFailure,
      settlement: settled, render: rendered, delivery: delivered,
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
    hostFailure: (error, status, upstream, candidate) => {
      hostFailure = { status, candidate, error: upstream ? { kind: 'upstream' } : { kind: 'failed', reason: oneLine(error) } };
    },
  };
};
