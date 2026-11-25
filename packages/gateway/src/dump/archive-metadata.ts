import type { ComputedUsage } from '../data-plane/pipeline/compute-usage.ts';
import type { GatewayPipelineFacts } from '../data-plane/pipeline/facts.ts';
import { isManagedStream } from '@floway-dev/pipeline';
import type { Deferred, ManagedStream, RunEvent } from '@floway-dev/pipeline';
import type { UpstreamProviderKind } from '@floway-dev/provider';

export interface ArchiveMetadata {
  readonly id: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly model: string | null;
  readonly durationMs: number;
  readonly ttftMs: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly error: string | null;
}

export interface PipelineDumpMetadata extends ArchiveMetadata {
  readonly upstream: { readonly id: string; readonly name: string; readonly kind: UpstreamProviderKind; readonly hue: number } | null;
}

export type CommitDumpArchive = (metadata: ArchiveMetadata, upstreamId: string | null) => Promise<void>;

type Body = Uint8Array | ManagedStream<unknown, unknown> | null;

interface Attempt {
  readonly upstreamId: string;
  usage?: { readonly deferred: Deferred<ComputedUsage>; readonly depth: number };
}

interface StreamSummary {
  bytes: number;
  firstFrameAt?: number;
  failure?: { readonly error: unknown };
}

const bodyBytes = (body: unknown): Body => body instanceof Uint8Array || isManagedStream(body) ? body : null;

const tokenSum = (counts: readonly (number | undefined)[]): number | null => {
  const present = counts.filter(count => count !== undefined);
  return present.length ? present.reduce((sum, count) => sum + count, 0) : null;
};

const describeFailure = (error: unknown): string => {
  if (error instanceof Error || error instanceof DOMException) return error.message;
  if (typeof error === 'string') return error;
  return 'Pipeline failed';
};

export const collectArchiveMetadata = (id: string, startedAt: number) => {
  let root: { readonly stageId: number; readonly method: string; readonly url: string } | undefined;
  let model: string | null = null;
  let status: number | null = null;
  let error: string | null = null;
  let requestBody: Body = null;
  let responseBody: Body = null;
  let selected: Attempt | undefined;
  const streams = new WeakMap<ManagedStream<unknown, unknown>, StreamSummary>();
  const settlements = new WeakMap<Deferred<unknown>, unknown>();
  const candidates = new Map<number, { readonly attempt: Attempt; readonly depth: number }>();
  const failovers = new Set<number>();
  const returned = new WeakMap<object, Attempt>();
  const size = (body: Body): number => body instanceof Uint8Array ? body.byteLength : body === null ? 0 : streams.get(body)?.bytes ?? 0;

  return {
    observe(event: RunEvent, elapsedMs: number): void {
      switch (event.type) {
      case 'stage.entered': {
        const { stageId, parentStageId, name } = event;
        const facts = event.facts as Partial<GatewayPipelineFacts>;
        const request = facts['request.http'];
        if (parentStageId === undefined) {
          if (!request) throw new TypeError('The gateway pipeline entry is missing request.http');
          root = { stageId, method: request.method, url: request.url };
          requestBody = bodyBytes(request.body);
        } else if (parentStageId === root?.stageId && requestBody === null && request?.url === root.url && request.method === root.method) {
          requestBody = bodyBytes(request.body);
        }
        model ??= facts['serve.model'] ?? null;
        const parent = parentStageId === undefined ? undefined : candidates.get(parentStageId);
        const upstreamId = facts['serve.candidate']?.upstream.id;
        if (parent) candidates.set(stageId, { attempt: parent.attempt, depth: parent.depth + 1 });
        else if (upstreamId !== undefined) candidates.set(stageId, { attempt: { upstreamId }, depth: 0 });
        else if (name === 'serve.failover') failovers.add(stageId);
        return;
      }
      case 'stage.leaved': {
        const { stageId, facts } = event;
        const answer = facts as Partial<GatewayPipelineFacts>;
        const candidate = candidates.get(stageId);
        if (candidate) {
          const { attempt, depth } = candidate;
          const usage = answer['response.usage'];
          if (usage !== undefined && (attempt.usage === undefined || depth < attempt.usage.depth)) attempt.usage = { deferred: usage, depth };
          returned.set(facts, attempt);
        }
        if (failovers.has(stageId)) selected = returned.get(facts);
        if (stageId === root?.stageId) {
          status = answer['response.http']?.status ?? null;
          model = answer['response.modelKey'] ?? model;
          responseBody = bodyBytes(answer['response.http']?.body);
        }
        return;
      }
      case 'stage.panicked':
        if (event.stageId === root?.stageId) error = describeFailure(event.error);
        return;
      case 'stream.frame': {
        const summary = streams.get(event.stream) ?? { bytes: 0 };
        if (event.item.ok) {
          summary.firstFrameAt ??= elapsedMs;
          if (event.item.value instanceof Uint8Array) summary.bytes += event.item.value.byteLength;
        } else summary.failure = { error: event.item.error };
        streams.set(event.stream, summary);
        return;
      }
      case 'deferred.settled':
        if (event.ok) settlements.set(event.deferred, event.value);
      }
    },
    complete(completedAt: number, durationMs: number): { metadata: ArchiveMetadata; upstreamId: string | null } {
      if (!root) throw new Error('Cannot archive a pipeline dump without a root stage');
      const responseStream = isManagedStream(responseBody) ? streams.get(responseBody) : undefined;
      const streamError = responseStream?.failure;
      const failure = streamError?.error;
      const reason = typeof failure === 'object' && failure !== null && 'cause' in failure ? failure.cause : failure;
      const observation = selected?.usage === undefined ? undefined
        : (settlements.get(selected.usage.deferred) as ComputedUsage | undefined)?.observation;
      const tokens = observation?.kind === 'reported' ? observation.measurement.dumpTokenUsage : null;
      return {
        metadata: {
          id, startedAt, completedAt, method: root.method, path: new URL(root.url).pathname,
          status, model, durationMs, ttftMs: responseStream?.firstFrameAt ?? null,
          error: error ?? (streamError ? describeFailure(reason) : null),
          requestBytes: size(requestBody), responseBytes: size(responseBody),
          inputTokens: tokens === null ? null : tokenSum([tokens.input, tokens.input_cache_read, tokens.input_cache_write, tokens.input_cache_write_1h, tokens.input_image]),
          outputTokens: tokens === null ? null : tokenSum([tokens.output, tokens.output_image]),
        },
        upstreamId: selected?.upstreamId ?? null,
      };
    },
  };
};
