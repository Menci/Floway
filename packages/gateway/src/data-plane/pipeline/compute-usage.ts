import { defineOperationStage, type GatewayPipelineFacts, type OperationEvent, type OperationResult } from './facts.ts';
import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import type { Facts, ManagedStream } from '@floway-dev/pipeline';
import type { ProtocolError, ProtocolStreamError, ProviderOperation } from '@floway-dev/provider';

type Usage = readonly UsageMeasurement[];

export type UsageObservation =
  | { kind: 'observed'; usage: readonly [] }
  | { kind: 'observed'; usage: Usage; modelKey: string }
  | { kind: 'upstream-error' }
  | { kind: 'local' };

export interface StreamUsage<Event> {
  frame(event: Event): Usage | undefined;
  done(): Usage;
  error?(error: ProtocolStreamError): Usage | undefined;
}

type UsageNeed<Op extends ProviderOperation> = 'provider.model' | 'provider.upstream' | 'response.http' | `request.${Op}`;
type UsageContext<Needs extends readonly (keyof GatewayPipelineFacts)[]> = Pick<GatewayPipelineFacts, Needs[number]>;

interface UsageReaders<Op extends ProviderOperation, Needs extends readonly UsageNeed<Op>[]> {
  needs?: Needs;
  result?(result: OperationResult<Op>, context: UsageContext<Needs>): Usage;
  stream?(context: UsageContext<Needs>): StreamUsage<OperationEvent<Op>>;
}

type Outcome<Op extends ProviderOperation> =
  | { kind: 'result'; result: OperationResult<Op> }
  | { kind: 'stream'; stream: ManagedStream<OperationEvent<Op>, ProtocolStreamError> }
  | ProtocolError;

export const computeUsage = <Op extends ProviderOperation, const Needs extends readonly UsageNeed<Op>[] = readonly []>(
  operation: Op,
  readers: UsageReaders<Op, Needs>,
) => {
  const outcome: string = `response.${operation}`;
  const keys = readers.needs ?? [];
  const requestNeeds: readonly string[] = keys.filter(key => key !== 'response.http');
  const responseNeeds: readonly string[] = [outcome, 'response.usageModelKey?', ...keys.filter(key => key === 'response.http')];
  const responseProvides: readonly string[] = [outcome, 'response.usage'];
  return defineOperationStage({
    name: `${operation}.compute-usage`,
    through: {
      request: { needs: requestNeeds, provides: [], consumes: [] },
      response: { needs: responseNeeds, provides: responseProvides, consumes: ['response.usageModelKey'] },
    },
    async execute(facts, scope) {
      const { 'response.usageModelKey': modelKey, ...answer }: Facts = await scope.next(facts);
      const parsed = answer[outcome] as Outcome<Op>;
      if (parsed.kind === 'error') {
        const usage = scope.createDeferred(async (): Promise<UsageObservation> => ({
          kind: parsed.source === 'upstream' ? 'upstream-error' : 'local',
        }));
        return { ...answer, 'response.usage': usage };
      }
      const observe = (usage: Usage): UsageObservation => {
        if (usage.length === 0) return { kind: 'observed', usage: [] };
        if (typeof modelKey !== 'string' || modelKey === '') {
          throw new Error(`The ${operation} provider returned billable usage without a dispatched model key`);
        }
        return { kind: 'observed', usage, modelKey };
      };
      const context = Object.fromEntries(keys.map(key => [key, key === 'response.http' ? answer[key] : facts[key]])) as UsageContext<Needs>;
      if (parsed.kind === 'result') {
        if (!readers.result) throw new Error(`No usage reader for ${operation} result`);
        const observed = observe(readers.result(parsed.result, context));
        const usage = scope.createDeferred(async () => observed);
        return { ...answer, 'response.usage': usage };
      }

      if (!readers.stream) throw new Error(`No usage reader for ${operation} stream`);
      const reader = readers.stream(context);
      const observation = Promise.withResolvers<UsageObservation>();
      const usage = scope.createDeferred(() => observation.promise);
      const stream = scope.wrapStream(parsed.stream, async function* (inner, producer) {
        let reported = false;
        try {
          for await (const item of producer.read(inner)) {
            if (!item.ok) {
              if (!reported) {
                if (item.error.kind === 'abort') {
                  observation.resolve({ kind: 'local' });
                } else {
                  const observed = reader.error?.(item.error);
                  observation.resolve(observed === undefined ? { kind: 'upstream-error' } : observe(observed));
                }
              }
              producer.discard(inner);
              yield item;
              return;
            }
            if (!reported) {
              const observed = reader.frame(item.value);
              if (observed !== undefined) {
                observation.resolve(observe(observed));
                reported = true;
              }
            }
            yield item;
          }
          if (!reported) observation.resolve(observe(reader.done()));
        } catch (error) {
          observation.reject(error);
          throw error;
        }
      });
      return { ...answer, [outcome]: { kind: 'stream', stream }, 'response.usage': usage };
    },
  });
};
