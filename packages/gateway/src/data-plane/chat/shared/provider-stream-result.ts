import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type EventResultMetadata, type ExecuteResult, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';

export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
  // Reads the upstream's own usage off one of its events, in the upstream's
  // own protocol. This is the only place pricing figures are produced; nothing
  // downstream re-derives them from the translated result the client receives.
  readBillableUsage: (event: TEvent) => BillableUsage | null,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstreamId)), performance: context };
  }
  const identity = telemetryModelIdentity(candidate, providerResult.modelKey);
  let resolveFinal!: (metadata: EventResultMetadata) => void;
  const finalMetadata = new Promise<EventResultMetadata>(resolve => { resolveFinal = resolve; });
  // Only a report carrying real counts replaces the running figure, so a
  // trailing empty usage frame cannot wipe a good one. Held outside the
  // generator so final metadata can resolve after the transport drains the
  // complete upstream stream.
  let billableUsage: BillableUsage | undefined;
  let metadataSettled = false;
  const settleMetadata = (): void => {
    if (metadataSettled) return;
    metadataSettled = true;
    resolveFinal({
      modelIdentity: identity,
      ...(context !== undefined ? { performance: context } : {}),
      ...(billableUsage !== undefined ? { billableUsage } : {}),
    });
  };
  const observeFrame = (frame: ProtocolFrame<TEvent>): void => {
    if (ctx.attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
      ctx.attempt.firstOutputTokenAt = performance.now();
    }
    if (frame.type === 'event') {
      const reported = readBillableUsage(frame.event);
      if (reported !== null) billableUsage = reported;
    }
  };
  // Downstream protocol wrappers finish at their terminal event, and an async
  // generator's suspended-start return() skips its body entirely. This owned
  // iterator makes every exit path enter the same drain and metadata lifecycle.
  let source: AsyncIterator<ProtocolFrame<TEvent>> | undefined;
  let sourceDone = false;
  let sourceReadFailed = false;
  let consumerDone = false;
  let operationTail: Promise<void> = Promise.resolve();

  const sourceIterator = (): AsyncIterator<ProtocolFrame<TEvent>> => {
    source ??= providerResult.events[Symbol.asyncIterator]();
    return source;
  };
  const readSource = async (): Promise<IteratorResult<ProtocolFrame<TEvent>>> => {
    if (sourceDone) return { done: true, value: undefined };
    try {
      const next = await sourceIterator().next();
      if (next.done) sourceDone = true;
      return next;
    } catch (error) {
      sourceReadFailed = true;
      throw error;
    }
  };
  const closeSource = async (errors: unknown[]): Promise<void> => {
    if (sourceDone) return;
    sourceDone = true;
    try {
      await source?.return?.();
    } catch (error) {
      errors.push(error);
    }
  };
  const drainSource = async (errors: unknown[]): Promise<void> => {
    try {
      if (sourceReadFailed) {
        await closeSource(errors);
        return;
      }
      while (!sourceDone) {
        let next: IteratorResult<ProtocolFrame<TEvent>>;
        try {
          next = await readSource();
        } catch (error) {
          errors.push(error);
          await closeSource(errors);
          break;
        }
        if (next.done) break;
        try {
          observeFrame(next.value);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      settleMetadata();
    }
  };
  const throwCollected = (errors: readonly unknown[], message: string): never => {
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, message, { cause: errors[0] });
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => {}, () => {});
    return result;
  };

  const stampedEvents: AsyncIterableIterator<ProtocolFrame<TEvent>> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => serialize(async () => {
      if (consumerDone) return { done: true, value: undefined };
      try {
        const next = await readSource();
        if (next.done) {
          consumerDone = true;
          settleMetadata();
          return next;
        }
        observeFrame(next.value);
        return next;
      } catch (error) {
        consumerDone = true;
        const errors = [error];
        await drainSource(errors);
        return throwCollected(errors, 'Provider event stream and retained drain both failed');
      }
    }),
    return: value => serialize(async () => {
      consumerDone = true;
      const errors: unknown[] = [];
      await drainSource(errors);
      if (errors.length > 0) return throwCollected(errors, 'Retained provider event drain failed');
      return { done: true, value };
    }),
    throw: error => serialize(async () => {
      consumerDone = true;
      const errors = [error];
      await drainSource(errors);
      return throwCollected(errors, 'Provider event consumer and retained drain both failed');
    }),
  };
  return {
    ...eventResult(stampedEvents, identity, { performance: context, headers: providerResult.headers }),
    finalMetadata,
  };
};
