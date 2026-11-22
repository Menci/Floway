import { getDumpBroker, getDumpStore } from './registry.ts';
import { dumpMetadataSchema } from './schemas.ts';
import { type DumpErrorMeta, type DumpLiveSummary, type DumpMetadata, dumpLiveStreamId } from './types.ts';
import type { HttpDelivery } from '../data-plane/pipeline/edge-http.ts';
import type { RenderOutcome } from '../data-plane/pipeline/render.ts';
import type { Settlement } from '../data-plane/pipeline/settlement.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createDumpDecoder, createDumpPump, type DumpCompletionSummary, type DumpViewModel, isDecodedDeferredRef, projectWireExchanges } from '@floway-dev/dump';
import type { HttpRequestFacts } from '@floway-dev/http';
import { Bytes, type RunEventSink } from '@floway-dev/pipeline';
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

const decodedRootDeferred = <T>(view: DumpViewModel, key: string): T | undefined => {
  const rootId = view.rootStageIds[0];
  const root = rootId === undefined ? undefined : view.stages.get(rootId);
  const deferred = root?.responseFacts?.[key];
  if (!isDecodedDeferredRef(deferred)) return undefined;
  const settled = view.deferreds.get(deferred.$deferred)?.settlement;
  return settled?.ok ? settled.value as T : undefined;
};

const modelFromTrace = (view: DumpViewModel): string | null => {
  for (const stage of view.stages.values()) {
    const model = stage.facts['request.model'];
    if (typeof model === 'string') return model;
  }
  return null;
};

interface HostFailure { readonly status: number; readonly error: DumpErrorMeta }

const renderFailureMessages = {
  'protocol-error': 'Upstream SSE reported an error',
  'premature-eof': 'Upstream SSE ended before its terminal frame',
  'source-error': 'Upstream response rendering failed',
  'collect-error': 'Upstream response collection failed',
} satisfies Record<Extract<RenderOutcome, { kind: 'failed' }>['reason'], string>;

const dumpError = (view: DumpViewModel, settlement: Settlement | undefined, summary: DumpCompletionSummary, hostFailure: HostFailure | undefined): DumpErrorMeta | null => {
  if (hostFailure !== undefined) return hostFailure.error;
  if (settlement?.outcome === 'gateway-error') return { kind: 'gateway' };
  if (settlement?.outcome === 'upstream-error') return { kind: 'upstream' };
  if (!summary.ok || settlement?.outcome === 'failed') {
    const render = decodedRootDeferred<RenderOutcome>(view, 'response.render');
    if (render?.kind === 'failed') return { kind: 'failed', reason: oneLine(render.error?.message ?? renderFailureMessages[render.reason]) };
    const delivery = decodedRootDeferred<HttpDelivery>(view, 'response.delivery');
    if (delivery?.kind === 'client-cancelled') return { kind: 'failed', reason: 'Downstream cancelled the SSE response' };
    if (delivery?.kind === 'write-failed') return { kind: 'failed', reason: oneLine(delivery.error.message) };
    return { kind: 'failed', reason: summary.doneError?.message ?? 'Downstream response did not complete' };
  }
  return null;
};

const buildMetadata = async (
  started: DumpLiveSummary, view: DumpViewModel, summary: DumpCompletionSummary, hostFailure: HostFailure | undefined,
): Promise<DumpMetadata> => {
  const { downstreamRequest, downstreamResponse } = projectWireExchanges(view);
  const settlement = decodedRootDeferred<Settlement>(view, 'response.settlement');
  const completedAt = Date.now();
  const record = settlement?.upstreamId ? await getRepo().upstreams.getById(settlement.upstreamId) : null;
  const responseBytes = downstreamResponse?.body instanceof Bytes ? downstreamResponse.body.byteLength
    : downstreamResponse?.stream?.frames.reduce((sum, { value }) => sum + (value instanceof Bytes ? value.byteLength : 0), 0) ?? 0;
  return dumpMetadataSchema.parse({
    ...started,
    completedAt,
    method: downstreamRequest?.method ?? started.method,
    path: downstreamRequest?.url.pathname ?? started.path,
    status: hostFailure?.status ?? downstreamResponse?.status ?? settlement?.status ?? (summary.ok ? 200 : 500),
    upstream: record === null ? null : { id: record.id, name: record.name, kind: record.kind, hue: record.hue },
    model: settlement?.identity?.model ?? started.model ?? modelFromTrace(view),
    inputTokens: inputTokens(settlement?.tokenUsage),
    outputTokens: settlement?.tokenUsage?.output ?? null,
    requestBytes: downstreamRequest?.body instanceof Bytes ? downstreamRequest.body.byteLength : started.requestBytes,
    responseBytes,
    durationMs: completedAt - started.startedAt,
    ttftMs: settlement?.firstOutputAt == null || settlement.upstreamStartedAt === null ? null : Math.round(settlement.firstOutputAt - settlement.upstreamStartedAt),
    error: dumpError(view, settlement, summary, hostFailure),
    targetApi: settlement?.targetApi ?? null,
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
  const started: DumpLiveSummary = {
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
  const announced = live.then(() => broker.publish(keyId, { event: 'started', data: started }))
    .catch(error => reportFailure('broker start publish', error));

  const pump = createDumpPump({
    onLiveChunk: async (offset, bytes) => { await (await live)?.append(offset, bytes); },
    onLiveEnd: async () => { await (await live)?.end(); },
  });
  const decoder = createDumpDecoder();
  const artifact = pump.artifact.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      decoder.push(chunk);
      controller.enqueue(chunk);
    },
  }));
  const written = store.stageAndPutArtifact(keyId, recordId, artifactKey, artifact);
  void written.catch(error => artifact.cancel(error).catch(() => undefined));
  let hostFailure: HostFailure | undefined;
  const completed = Promise.all([pump.completed, written]).then(async ([summary]) => {
    const meta = await buildMetadata(started, decoder.finish(), summary, hostFailure);
    await store.commitRecord(keyId, { meta, artifactKey });
    await announced;
    try {
      await broker.publish(keyId, { event: 'appended', data: meta });
    } catch (error) {
      reportFailure('broker publish', error);
    }
  }).catch(error => reportFailure('pipeline', error));

  return {
    recordId,
    sink: pump.sink,
    completed,
    hostFailure: (error, status, upstream) => {
      hostFailure = { status, error: upstream ? { kind: 'upstream' } : { kind: 'failed', reason: oneLine(error) } };
    },
  };
};
