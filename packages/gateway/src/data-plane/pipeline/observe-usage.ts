import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import { defineStage, type Deferred, type ManagedStream, type StageEnv, type StreamEnd } from '@floway-dev/pipeline';
import type { BillableUsage, PricingRuntimeFacts, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderHttpOutput, TelemetryModelIdentity } from '@floway-dev/provider';

export interface BillableCall {
  readonly callId: string;
  readonly identity: TelemetryModelIdentity;
  readonly pricingFacts: PricingRuntimeFacts;
  readonly usage: BillableUsage | null;
  readonly observedAt: number;
  readonly disposition: 'completed' | 'api-error' | 'stream-error' | 'released' | 'cancelled';
  readonly measurement?: UsageMeasurement;
}

export interface UsageFacts {
  readonly 'response.usage.billable': Deferred<readonly BillableCall[]>;
  readonly 'response.timing.firstOutputAt': Deferred<number | null>;
  readonly 'response.timing.streamEndedAt': Deferred<number | null>;
}

export const usageResponseKeys = ['response.usage.billable', 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'] as const;

export const emptyUsageFacts = (env: Pick<StageEnv, 'defer'>): UsageFacts => ({
  'response.usage.billable': env.defer('billable calls', Promise.resolve([])),
  'response.timing.firstOutputAt': env.defer('first output', Promise.resolve(null)),
  'response.timing.streamEndedAt': env.defer('stream end', Promise.resolve(null)),
});

export const mergeBillableCalls = (
  attempts: readonly Deferred<readonly BillableCall[]>[],
): Promise<readonly BillableCall[]> => Promise.allSettled(attempts.map(attempt => attempt.promise))
  .then(results => results.flatMap(result => result.status === 'fulfilled' ? result.value : []));

export type ObservedUsage = Pick<BillableCall, 'usage' | 'measurement' | 'pricingFacts'>;

export const observedTokenUsage = (usage: BillableUsage | null): ObservedUsage => ({
  usage,
  pricingFacts: usage === null ? {} : {
    serviceTier: usage.tier,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h,
  },
});

export const observeIdentity = (candidate: { readonly modelId: string; readonly upstreamId: string; readonly providerModel: { readonly pricing?: TelemetryModelIdentity['pricing'] } }, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.modelId,
  upstream: candidate.upstreamId,
  modelKey,
  pricing: candidate.providerModel.pricing ?? null,
});

type TimedEnv = Pick<StageEnv, 'runId' | 'stageId' | 'clock' | 'defer'>;

export const billableCall = (env: TimedEnv, identity: TelemetryModelIdentity, disposition: BillableCall['disposition'], usage: ObservedUsage): BillableCall => ({
  ...usage,
  callId: `${env.runId}/${env.stageId}`,
  identity,
  disposition,
  observedAt: env.clock(),
});

const observedCalls = (call: BillableCall, accepted: boolean): readonly BillableCall[] =>
  accepted || call.usage !== null || Object.keys(call.measurement?.quantities ?? {}).length > 0 ? [call] : [];

export const scalarUsageFacts = (env: TimedEnv, call: BillableCall): UsageFacts => ({
  'response.usage.billable': env.defer('billable call', Promise.resolve(observedCalls(call, call.disposition !== 'api-error'))),
  'response.timing.firstOutputAt': env.defer('first output', Promise.resolve(null)),
  'response.timing.streamEndedAt': env.defer('stream end', Promise.resolve(null)),
});

interface StreamObserver<Event> {
  readonly frame: (frame: ProtocolFrame<Event>) => { readonly output?: boolean; readonly failed?: boolean } | void;
  readonly usage: () => ObservedUsage;
}

interface ObservedResponse<Event, Result> extends ProviderHttpOutput {
  readonly 'response.events'?: ManagedStream<ProtocolFrame<Event>>;
  readonly 'response.result'?: Result;
}

const streamDisposition = (end: StreamEnd, failed: boolean): BillableCall['disposition'] => {
  switch (end.how) {
  case 'exhausted': return failed ? 'stream-error' : 'completed';
  case 'released': return failed ? 'stream-error' : 'released';
  case 'cancelled': return 'cancelled';
  case 'errored':
  case 'leaked': return 'stream-error';
  }
};

export const createObserveUsage = <Event, Result = undefined>(dialect: {
  readonly open: () => StreamObserver<Event>;
  readonly scalar?: (result: Result) => ObservedUsage;
}) => {
  type Request = { readonly 'route.candidate': Parameters<typeof observeIdentity>[0] };
  type Response = ObservedResponse<Event, Result>;
  return defineStage<Request, Request, Response, Response & UsageFacts>({
    name: 'observeUsage',
    through: {
      request: { needs: ['route.candidate'], consumes: [], provides: [] },
      response: { needs: ['response.http', 'response.modelKey'], consumes: [], provides: ['response.events', ...usageResponseKeys] },
    },
    execute: async (request, next, env) => {
      const response = await next(request);
      const { 'response.http': http, 'response.events': events, 'response.result': result } = response;
      const accepted = http.status >= 200 && http.status < 300;
      const identity = observeIdentity(request['route.candidate'], response['response.modelKey']);
      if (events === undefined) {
        const usage = result !== undefined && dialect.scalar !== undefined ? dialect.scalar(result) : observedTokenUsage(null);
        return { ...response, 'response.events': undefined, ...scalarUsageFacts(env, billableCall(env, identity, accepted ? 'completed' : 'api-error', usage)) };
      }

      const observer = dialect.open();
      let firstOutputAt: number | null = null;
      let failed = false;
      const observed = env.wrapStream(events, {
        label: 'observed upstream events',
        async *transform(source) {
          for await (const frame of source) {
            const observation = observer.frame(frame);
            if (observation?.output) firstOutputAt ??= env.clock();
            failed ||= observation?.failed === true;
            yield frame;
          }
        },
        onClose: end => {
          firstOutput.resolve(firstOutputAt);
          streamEnd.resolve(env.clock());
          const disposition = streamDisposition(end, failed);
          try {
            billing.resolve(observedCalls(billableCall(env, identity, disposition, observer.usage()), accepted));
          } catch (error) {
            billing.reject(error);
          }
        },
      });
      const billing = env.deferred<readonly BillableCall[]>('billable call', observed);
      const firstOutput = env.deferred<number | null>('first output', observed);
      const streamEnd = env.deferred<number | null>('stream end', observed);
      return {
        ...response,
        'response.events': observed,
        'response.usage.billable': billing.deferred,
        'response.timing.firstOutputAt': firstOutput.deferred,
        'response.timing.streamEndedAt': streamEnd.deferred,
      };
    },
  });
};
