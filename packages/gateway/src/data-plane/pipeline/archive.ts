import type { UsageObservation } from './compute-usage.ts';
import type { GatewayPipelineFacts, ResponseOutcome } from './facts.ts';
import { getDumpBroker, getDumpStore } from '../../dump/registry.ts';
import type { DumpMetadata } from '../../dump/types.ts';
import { getRepo } from '../../repo/index.ts';
import { ulid } from '../../shared/ulid.ts';
import { createDumpRecorder } from '@floway-dev/dump';
import type { HttpRequestFact } from '@floway-dev/http';
import type { BackgroundScheduler } from '@floway-dev/platform';

type Candidate = GatewayPipelineFacts['response.candidate'];

interface CompletedResponse {
  status: number;
  responseBytes: number;
  candidate: Candidate | undefined;
  requestedModel?: string | undefined;
  usage: Promise<UsageObservation | undefined>;
  performance?: Promise<{ ttftMs: number | null } | undefined>;
  outcome?: Promise<ResponseOutcome | undefined>;
  error?: unknown;
}

export const openRequestArchive = (
  keyId: string,
  request: HttpRequestFact,
  startedAt: number,
  waitUntil: BackgroundScheduler,
) => {
  const recorder = createDumpRecorder(waitUntil);
  const completed = Promise.withResolvers<CompletedResponse & { completedAt: number }>();
  const archive = async (): Promise<void> => {
    const [bytes, result] = await Promise.all([new Response(recorder.body).arrayBuffer(), completed.promise]);
    const { completedAt } = result;
    const upstream = result.candidate ? await getRepo().upstreams.getById(result.candidate.upstreamId) : null;
    // The host has already handled a live usage panic; the recorder keeps
    // the deferred's own error event inside the archived pipeline.
    const [observation, performance, outcome] = await Promise.all([
      result.usage.catch(() => undefined),
      result.performance?.catch(() => undefined),
      result.outcome?.catch(() => undefined),
    ]);
    const usage = observation?.kind === 'observed' ? observation.usage : [];
    const tokens = usage.flatMap(item => item.dumpTokenUsage === null ? [] : [item.dumpTokenUsage]);
    const hasTokens = tokens.length > 0;
    const meta: DumpMetadata = {
      id: ulid(completedAt),
      startedAt,
      completedAt,
      method: request.method,
      path: new URL(request.url).pathname,
      status: result.status,
      requestBytes: request.body?.byteLength ?? 0,
      responseBytes: result.responseBytes,
      durationMs: completedAt - startedAt,
      model: result.candidate?.model ?? result.requestedModel ?? null,
      upstream: upstream === null ? null : { id: upstream.id, name: upstream.name, kind: upstream.kind, hue: upstream.hue },
      inputTokens: hasTokens ? tokens.reduce((sum, token) => sum + (token.input ?? 0) + (token.input_cache_read ?? 0) + (token.input_cache_write ?? 0) + (token.input_cache_write_1h ?? 0) + (token.input_image ?? 0), 0) : null,
      outputTokens: hasTokens ? tokens.reduce((sum, token) => sum + (token.output ?? 0) + (token.output_image ?? 0), 0) : null,
      ttftMs: performance?.ttftMs ?? null,
      error: result.error !== undefined
        ? { kind: 'failed', reason: result.error instanceof Error ? result.error.message : String(result.error) }
        : outcome === 'upstream' ? { kind: 'upstream' }
          : outcome === 'local' ? { kind: 'gateway' } : null,
    };
    await getDumpStore().putArchive(keyId, meta, new Uint8Array(bytes));
    await getDumpBroker().publish(keyId, meta);
  };
  return {
    events: recorder.events,
    waitUntil: recorder.waitUntil,
    finish(done: Promise<void>) {
      waitUntil(archive());
      waitUntil(recorder.finish(done));
    },
    complete(result: CompletedResponse) {
      completed.resolve({ ...result, completedAt: Date.now() });
    },
  };
};
