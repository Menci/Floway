import { gatewayFactSpace, type GatewayPipelineFacts, type ProtocolResponseKey } from './facts.ts';
import { isHttpStreamError, observeStreamOutcome, type ProtocolEvent, type StreamVerdict } from './protocol-outcome.ts';
import type { PerformanceDimensions, PerformanceRepo } from '../../repo/types.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import { move, type ManagedStream } from '@floway-dev/pipeline';
import { decimalStringToNumber } from '@floway-dev/protocols/common';
import type { PerformanceOperation, ProtocolStreamError } from '@floway-dev/provider';

export interface PerformanceServices {
  readonly runtimeLocation: string;
  readonly performance: Pick<PerformanceRepo, 'recordSample' | 'recordNeutral' | 'recordZeroOutputError'>;
}

interface StreamPerformanceObserver<Event> {
  readonly firstOutput: (event: Event) => boolean;
  readonly verdict?: (event: Event) => StreamVerdict | undefined;
}

type ScalarChatOperation = 'anthropicMessagesCountTokens' | 'geminiGenerateContentCountTokens' | 'openaiResponsesCompact';

const { defineStage } = gatewayFactSpace<PerformanceServices>();

export const recordPerformance = <const Key extends ProtocolResponseKey>(
  responseKey: Key,
  operation: PerformanceOperation | { readonly operation: 'chat'; readonly providerOperation: ScalarChatOperation },
  observer?: StreamPerformanceObserver<ProtocolEvent<Key>>,
) => {
  const through = {
    request: { needs: ['request.auth.apiKeyId', 'serve.candidate'], provides: [], consumes: [] },
    response: { needs: ['response.usage', responseKey], provides: [responseKey], consumes: [] },
  } as const;
  const definePerformance = defineStage<typeof through>;
  type MeteredAnswer = Awaited<ReturnType<Parameters<typeof definePerformance>[0]['execute']>>;
  return definePerformance({
    name: 'serve.performance',
    through,
    async execute(facts, scope) {
      const { model, upstream } = facts['serve.candidate'];
      const dimensions = {
        keyId: facts['request.auth.apiKeyId'],
        model: model.id,
        upstream: upstream.id,
        operation: typeof operation === 'string' ? operation : operation.operation,
        runtimeLocation: scope.services.runtimeLocation,
        hour: currentHour(),
      };
      const startedAt = performance.now();
      const back = await scope.next(facts);
      const outcome = back[responseKey] as GatewayPipelineFacts[Key];
      const repository = scope.services.performance;
      const persist = (write: Promise<void>): Promise<void> => write.catch(error => {
        scope.log.warn('Floway could not record upstream performance', { error });
      });

      if (outcome.kind === 'error') {
        if (outcome.source === 'upstream' && !(isHttpStreamError(outcome.cause) && outcome.cause.kind === 'abort')) {
          scope.defer(persist(repository.recordZeroOutputError(dimensions)));
        }
        return back as MeteredAnswer;
      }
      if (outcome.kind === 'result') {
        if (operation === 'chat') throw new TypeError(`The ${responseKey} generation pipeline returned a scalar result`);
        scope.defer(persist(repository.recordNeutral(dimensions)));
        return back as MeteredAnswer;
      }

      const source = outcome.stream as ManagedStream<ProtocolEvent<Key>, ProtocolStreamError>;
      const stream = scope.wrapStream(source, async function* (items, producer) {
        const end = observeStreamOutcome(observer?.verdict);
        let firstOutputAt: number | undefined;
        for await (const item of items) {
          end.observe(item);
          if (item.ok && firstOutputAt === undefined && observer?.firstOutput(item.value)) firstOutputAt = performance.now();
          yield item;
        }

        const terminal = end.finish(producer.signal);
        if (terminal === 'cancelled') return;
        const finishedAt = performance.now();
        const { observation } = await back['response.usage'].promise;
        const tokens = observation.kind === 'reported' ? observation.measurement.quantities.output_tokens : undefined;
        const outputTokens = tokens === undefined ? 0 : decimalStringToNumber(tokens);
        producer.defer(persist(writePerformance(repository, dimensions, terminal === 'failure', outputTokens, startedAt, firstOutputAt, finishedAt)));
      });
      return { ...back, [responseKey]: move({ ...outcome, stream }) } as MeteredAnswer;
    },
  });
};

const writePerformance = (
  repository: PerformanceServices['performance'],
  dimensions: PerformanceDimensions,
  failed: boolean,
  outputTokens: number,
  startedAt: number,
  firstOutputAt: number | undefined,
  finishedAt: number,
): Promise<void> => {
  if (dimensions.operation !== 'chat' || firstOutputAt === undefined || (failed && outputTokens === 0)) {
    return failed ? repository.recordZeroOutputError(dimensions) : repository.recordNeutral(dimensions);
  }
  return repository.recordSample({
    ...dimensions,
    ttftMs: Math.round(firstOutputAt - startedAt),
    ...(outputTokens >= 2 ? { tpotUs: Math.round(((finishedAt - firstOutputAt) * 1_000) / (outputTokens - 1)) } : {}),
    success: !failed,
  });
};
