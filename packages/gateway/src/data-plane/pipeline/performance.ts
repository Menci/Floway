import type { UsageObservation } from './compute-usage.ts';
import { defineOperationStage, type GatewayPipelineFacts, type OperationEvent } from './facts.ts';
import { attemptTtftMs, type AttemptTiming } from '../shared/attempt-timing.ts';
import { persistPerformance } from '../shared/telemetry/performance.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream } from '@floway-dev/pipeline';
import type { PerformanceOperation, ProtocolError, ProtocolStreamError, ProviderOperation } from '@floway-dev/provider';

type PerformanceOutcome = 'local' | 'success' | 'upstream-error';
type MeteredOutcome<Event> = ProtocolError | { kind: 'result' } | { kind: 'stream'; stream: ManagedStream<Event, ProtocolStreamError> };

export const measurePerformance = <Op extends ProviderOperation>(
  operation: Op,
  performanceOperation: PerformanceOperation,
  isFirstOutput?: (event: OperationEvent<Op>) => boolean,
) => {
  const outcome: string = `response.${operation}`;
  const responseNeeds: readonly string[] = [outcome, 'response.usage', 'response.http'];
  const responseProvides: readonly string[] = [outcome, 'response.usage', 'response.performance'];
  return defineOperationStage({
    name: `${operation}.performance`,
    through: {
      request: {
        needs: ['request.auth.apiKeyId', 'serve.runtimeLocation', 'provider.upstream', 'provider.model'],
        provides: [],
        consumes: [],
      },
      response: { needs: responseNeeds, provides: responseProvides, consumes: [] },
    },
    async execute(facts, scope) {
      const keyId = facts['request.auth.apiKeyId'] as string;
      const runtimeLocation = facts['serve.runtimeLocation'] as string;
      const { id: upstream } = facts['provider.upstream'] as GatewayPipelineFacts['provider.upstream'];
      const { id: model } = facts['provider.model'] as GatewayPipelineFacts['provider.model'];
      const telemetry = { keyId, runtimeLocation, upstream, model, operation: performanceOperation };
      const answer = await scope.next(facts);
      const parsed = answer[outcome] as MeteredOutcome<OperationEvent<Op>>;
      const head = answer['response.http'] as HttpResponseFact | null;
      const timing: AttemptTiming = { upstreamCallStartedAt: head?.startedAt ?? null, firstOutputTokenAt: null };
      const measured = Promise.withResolvers<{ ttftMs: number | null }>();
      const responsePerformance = scope.createDeferred(() => measured.promise);
      // The factory opens usage synchronously, so forwarding and sampling share one read.
      let observed!: Promise<UsageObservation>;
      const usage = scope.wrapDeferred(answer['response.usage'] as GatewayPipelineFacts['response.usage'], (inner, producer) => {
        observed = producer.read(inner);
        return observed;
      });
      const readTime = (): void => measured.resolve({ ttftMs: attemptTtftMs(timing) });
      const countFirstOutput = (event: OperationEvent<Op>): void => {
        if (timing.firstOutputTokenAt === null && isFirstOutput?.(event)) {
          timing.firstOutputTokenAt = performance.now();
          readTime();
        }
      };
      const settle = (producer: Pick<typeof scope, 'detach'>, kind: PerformanceOutcome): void => {
        readTime();
        if (kind === 'local') return;
        const finishedAt = performance.now();
        producer.detach(async ({ log }) => {
          try {
            const observation = await observed;
            const output = observation.kind === 'observed'
              ? observation.usage.reduce((total, entry) => total + Number(entry.quantities.output_tokens ?? '0'), 0)
              : 0;
            await persistPerformance(timing, telemetry, kind === 'upstream-error', output, finishedAt);
          } catch (error) {
            log.withError(error).error('Floway failed to record upstream performance');
          }
        });
      };
      const measurements = { ...answer, 'response.usage': usage, 'response.performance': responsePerformance };

      if (parsed.kind !== 'stream') {
        settle(scope, parsed.kind === 'result' ? 'success' : parsed.source === 'upstream' ? 'upstream-error' : 'local');
        return measurements;
      }
      const stream = scope.wrapStream(parsed.stream, async function* (inner, producer) {
        try {
          for await (const item of producer.read(inner)) {
            if (!item.ok) {
              if (item.error.kind === 'protocol' && item.error.event !== undefined) {
                countFirstOutput(item.error.event as OperationEvent<Op>);
              }
              settle(producer, item.error.kind === 'abort' ? 'local' : 'upstream-error');
              producer.discard(inner);
              yield item;
              return;
            }
            countFirstOutput(item.value);
            yield item;
          }
          settle(producer, 'success');
        } catch (error) {
          measured.reject(error);
          throw error;
        }
      });
      return { ...measurements, [outcome]: { kind: 'stream', stream } };
    },
  });
};
