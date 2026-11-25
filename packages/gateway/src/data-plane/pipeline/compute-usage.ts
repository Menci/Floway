import { gatewayFactSpace, type GatewayPipelineFacts, type ProtocolResponseKey, type ServeCandidate } from './facts.ts';
import { isHttpStreamError, observeStreamOutcome, type ProtocolEvent, type ProtocolResult, type StreamVerdict } from './protocol-outcome.ts';
import type { UsageRecord } from '../../repo/types.ts';
import { usageMetrics } from '../../repo/usage-metrics.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { move, type ManagedStream } from '@floway-dev/pipeline';
import { priceRequest } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

export interface StreamUsageObserver<Event> {
  readonly observe: (event: Event) => UsageMeasurement | null;
  readonly finish: () => UsageMeasurement | null;
}

export interface UsageObserverContext {
  readonly candidate: ServeCandidate;
  readonly http: HttpResponseFact | null;
}

export type UsageObserver<Key extends ProtocolResponseKey> =
  | { readonly kind: 'unbillable' }
  | {
    readonly kind: 'billable';
    readonly result?: (result: ProtocolResult<Key>, context: UsageObserverContext) => UsageMeasurement | null;
    readonly stream?: (context: UsageObserverContext) => StreamUsageObserver<ProtocolEvent<Key>>;
    readonly error?: (body: unknown, context: UsageObserverContext) => UsageMeasurement | null;
  };

type UsageObservation =
  | { readonly kind: 'reported'; readonly measurement: UsageMeasurement }
  | { readonly kind: 'omitted' }
  | { readonly kind: 'failed-before-usage' }
  | { readonly kind: 'cancelled-before-usage' }
  | { readonly kind: 'no-upstream-call' };

export interface ComputedUsage {
  readonly observation: UsageObservation;
  readonly row: UsageRecord | null;
}

const { defineStage } = gatewayFactSpace<{}>();

export const computeUsage = <const Key extends ProtocolResponseKey>(
  responseKey: Key,
  observer: UsageObserver<Key>,
  verdict?: (event: ProtocolEvent<Key>) => StreamVerdict | undefined,
) => {
  const through = {
    request: { needs: ['request.auth.apiKeyId', 'serve.candidate'], provides: [], consumes: [] },
    response: {
      needs: ['response.http', 'response.modelKey', responseKey],
      provides: ['response.usage', responseKey],
      consumes: [],
    },
  } as const;
  const defineCompute = defineStage<typeof through>;
  type MeteredAnswer = Awaited<ReturnType<Parameters<typeof defineCompute>[0]['execute']>>;
  return defineCompute({
    name: 'serve.compute-usage',
    through,
    async execute(facts, scope) {
      const back = await scope.next(facts);
      const outcome = back[responseKey] as GatewayPipelineFacts[Key];
      const usage = scope.deferred<ComputedUsage>();
      const context = { candidate: facts['serve.candidate'], http: back['response.http'] };
      const settle = (observation: UsageObservation): void => {
        const row = observer.kind === 'billable'
          ? computeRow(observation, facts['request.auth.apiKeyId'], facts['serve.candidate'], back['response.modelKey'])
          : null;
        usage.resolve(move({ observation, row }));
      };

      if (outcome.kind === 'error') {
        const { source, cause } = outcome;
        const kind = source === 'local'
          ? 'no-upstream-call'
          : isHttpStreamError(cause) && cause.kind === 'abort' ? 'cancelled-before-usage' : 'failed-before-usage';
        const status = context.http?.status;
        const measurement = kind === 'failed-before-usage' && status !== undefined && status >= 200 && status < 300 && observer.kind === 'billable'
          ? observer.error?.(outcome.error, context)
          : null;
        settle(measurement ? { kind: 'reported', measurement } : { kind });
        return { ...back, 'response.usage': usage.deferred } as MeteredAnswer;
      }

      if (outcome.kind === 'result') {
        const measurement = observer.kind === 'unbillable' ? null : observer.result?.(outcome.result as ProtocolResult<Key>, context);
        if (measurement === undefined) throw new TypeError(`The ${responseKey} usage stage needs a result observer`);
        settle(measurement === null ? { kind: 'omitted' } : { kind: 'reported', measurement });
        return { ...back, 'response.usage': usage.deferred } as MeteredAnswer;
      }

      const measure = observer.kind === 'unbillable' ? null : observer.stream?.(context);
      if (measure === undefined) throw new TypeError(`The ${responseKey} usage stage needs a stream observer`);
      const source = outcome.stream as ManagedStream<ProtocolEvent<Key>, ProtocolStreamError>;
      const stream = scope.wrapStream(source, async function* (items, producer) {
        let reported = false;
        const end = observeStreamOutcome(verdict);
        for await (const item of items) {
          end.observe(item);
          if (item.ok && !reported) {
            const measurement = measure?.observe(item.value);
            if (measurement) {
              settle({ kind: 'reported', measurement });
              reported = true;
            }
          }
          yield item;
        }
        if (!reported) {
          const measurement = measure?.finish();
          if (measurement) {
            settle({ kind: 'reported', measurement });
            return;
          }
          const outcome = end.finish(producer.signal);
          settle({ kind: OBSERVATION_BY_END[outcome] });
        }
      });
      return {
        ...back,
        [responseKey]: move({ ...outcome, stream }),
        'response.usage': usage.deferred,
      } as MeteredAnswer;
    },
  });
};

const OBSERVATION_BY_END = {
  complete: 'omitted',
  failure: 'failed-before-usage',
  cancelled: 'cancelled-before-usage',
} as const;

const computeRow = (
  observation: UsageObservation,
  keyId: string,
  { upstream, model }: ServeCandidate,
  modelKey: string,
): UsageRecord | null => {
  if (observation.kind !== 'reported' && observation.kind !== 'omitted') return null;
  const measurement = observation.kind === 'reported' ? observation.measurement : null;
  const priced = priceRequest(model.pricing ?? null, measurement?.pricingFacts ?? {});
  return {
    keyId,
    model: model.id,
    upstream: upstream.id,
    modelKey,
    hour: currentHour(),
    pricingSelector: priced.selector,
    requests: 1,
    metrics: usageMetrics(measurement?.quantities ?? {}, priced.rates),
  };
};
