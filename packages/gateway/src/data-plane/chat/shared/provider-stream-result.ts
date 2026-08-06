import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { RETAINED_RESPONSE_LIMITS } from '../../shared/retained-response.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type EventResultMetadata, type ExecuteResult, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';

class ProviderStreamCleanupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider event stream cleanup exceeded its ${timeoutMs}ms deadline`);
    this.name = 'ProviderStreamCleanupTimeoutError';
  }
}

const PROVIDER_STREAM_CLEANUP_TIMEOUT_MS = RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs;
const PROVIDER_STREAM_TASK_YIELD_INTERVAL = 256;
const SOURCE_READ_INTERRUPTED = Symbol('source-read-interrupted');

const nextTask = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 0));

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError');

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
  let sourceReadInterrupted = false;
  let consumerDone = false;
  let operationTail: Promise<void> = Promise.resolve();
  let interruptActiveRead: (() => void) | undefined;
  let framesUntilTaskYield = PROVIDER_STREAM_TASK_YIELD_INTERVAL;

  const appendError = (errors: unknown[], error: unknown): void => {
    if (!errors.some(existing => Object.is(existing, error))) errors.push(error);
  };

  const sourceIterator = (): AsyncIterator<ProtocolFrame<TEvent>> => {
    source ??= providerResult.events[Symbol.asyncIterator]();
    return source;
  };
  const readSource = async (): Promise<IteratorResult<ProtocolFrame<TEvent>>> => {
    if (sourceDone) return { done: true, value: undefined };
    if (ctx.executionSignal.aborted) {
      sourceReadInterrupted = true;
      throw abortReason(ctx.executionSignal);
    }
    const pendingRead = Promise.resolve().then(async () => await sourceIterator().next());
    const sourceOutcome = pendingRead.then(
      result => ({ kind: 'source' as const, result }),
      error => ({ kind: 'source-error' as const, error }),
    );
    let resolveInterruption!: () => void;
    const interruption = new Promise<{ readonly kind: 'interrupted' }>(resolve => {
      resolveInterruption = () => resolve({ kind: 'interrupted' });
    });
    let removeExecutionAbortListener = (): void => {};
    const executionAbort = new Promise<{ readonly kind: 'execution-abort'; readonly error: unknown }>(resolve => {
      const onAbort = (): void => resolve({ kind: 'execution-abort', error: abortReason(ctx.executionSignal) });
      if (ctx.executionSignal.aborted) {
        onAbort();
        return;
      }
      ctx.executionSignal.addEventListener('abort', onAbort, { once: true });
      removeExecutionAbortListener = () => ctx.executionSignal.removeEventListener('abort', onAbort);
    });
    interruptActiveRead = resolveInterruption;
    try {
      const outcome = await Promise.race([sourceOutcome, interruption, executionAbort]);
      if (outcome.kind === 'source') {
        if (outcome.result.done) sourceDone = true;
        return outcome.result;
      }
      if (outcome.kind === 'source-error') {
        sourceReadFailed = true;
        throw outcome.error;
      }
      sourceReadInterrupted = true;
      // Promise.race observes the mapped outcome, but a late raw rejection has
      // crossed into cleanup ownership and still needs a top-level signal.
      void pendingRead.catch(error => {
        if (ctx.executionSignal.aborted && Object.is(error, ctx.executionSignal.reason)) return;
        console.error('[provider-stream] source read failed after interruption', error);
      });
      if (outcome.kind === 'execution-abort') throw outcome.error;
      throw SOURCE_READ_INTERRUPTED;
    } finally {
      removeExecutionAbortListener();
      if (interruptActiveRead === resolveInterruption) interruptActiveRead = undefined;
    }
  };
  type CleanupErrorSink = (error: unknown) => void;
  const closeSource = async (reportError: CleanupErrorSink): Promise<void> => {
    if (sourceDone) return;
    sourceDone = true;
    try {
      await source?.return?.();
    } catch (error) {
      reportError(error);
    }
  };
  const checkpointTaskQueue = async (): Promise<void> => {
    framesUntilTaskYield -= 1;
    if (framesUntilTaskYield > 0) return;
    framesUntilTaskYield = PROVIDER_STREAM_TASK_YIELD_INTERVAL;
    await nextTask();
    ctx.executionSignal.throwIfAborted();
  };
  const drainSource = async (reportError: CleanupErrorSink): Promise<void> => {
    if (sourceReadFailed || sourceReadInterrupted) {
      await closeSource(reportError);
      return;
    }
    while (!sourceDone) {
      let next: IteratorResult<ProtocolFrame<TEvent>>;
      try {
        next = await readSource();
      } catch (error) {
        if (error !== SOURCE_READ_INTERRUPTED) reportError(error);
        await closeSource(reportError);
        break;
      }
      if (next.done) break;
      try {
        observeFrame(next.value);
      } catch (error) {
        reportError(error);
      }
      try {
        await checkpointTaskQueue();
      } catch (error) {
        reportError(error);
        await closeSource(reportError);
        break;
      }
    }
  };
  const runCleanup = async (errors: unknown[]): Promise<void> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeExecutionAbortListener = (): void => {};
    let lifecycleSettled = false;
    const reportError: CleanupErrorSink = error => {
      if (lifecycleSettled) {
        if (errors.some(existing => Object.is(existing, error))) return;
        console.error('[provider-stream] cleanup failed after lifecycle settlement', error);
        return;
      }
      appendError(errors, error);
    };
    const drain = drainSource(reportError);
    const drained = drain.then(
      () => ({ kind: 'drained' as const }),
      error => ({ kind: 'drain-failed' as const, error }),
    );
    const timeout = new Promise<{ readonly kind: 'timeout'; readonly error: ProviderStreamCleanupTimeoutError }>(resolve => {
      timeoutId = setTimeout(() => {
        resolve({ kind: 'timeout', error: new ProviderStreamCleanupTimeoutError(PROVIDER_STREAM_CLEANUP_TIMEOUT_MS) });
      }, PROVIDER_STREAM_CLEANUP_TIMEOUT_MS);
    });
    const executionAbort = new Promise<{ readonly kind: 'execution-abort'; readonly error: unknown }>(resolve => {
      const onAbort = (): void => resolve({ kind: 'execution-abort', error: abortReason(ctx.executionSignal) });
      if (ctx.executionSignal.aborted) {
        onAbort();
        return;
      }
      ctx.executionSignal.addEventListener('abort', onAbort, { once: true });
      removeExecutionAbortListener = () => ctx.executionSignal.removeEventListener('abort', onAbort);
    });

    try {
      const outcome = await Promise.race([drained, timeout, executionAbort]);
      if (outcome.kind === 'drain-failed') {
        reportError(outcome.error);
      } else if (outcome.kind === 'timeout') {
        reportError(outcome.error);
        if (!ctx.executionSignal.aborted) ctx.executionController.abort(outcome.error);
        void closeSource(reportError);
      } else if (outcome.kind === 'execution-abort') {
        reportError(outcome.error);
        void closeSource(reportError);
      }
      if (outcome.kind !== 'drained' && outcome.kind !== 'drain-failed') {
        // The race owns observable settlement. Any later failure is reported by
        // the sink above because it can no longer be added to the thrown chain.
        void drain.catch(reportError);
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeExecutionAbortListener();
      settleMetadata();
      lifecycleSettled = true;
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
        await checkpointTaskQueue();
        return next;
      } catch (error) {
        if (error === SOURCE_READ_INTERRUPTED) return { done: true, value: undefined };
        consumerDone = true;
        const errors = [error];
        await runCleanup(errors);
        return throwCollected(errors, 'Provider event stream and retained drain both failed');
      }
    }),
    return: value => {
      consumerDone = true;
      interruptActiveRead?.();
      return serialize(async () => {
        const errors: unknown[] = [];
        await runCleanup(errors);
        if (errors.length > 0) return throwCollected(errors, 'Retained provider event drain failed');
        return { done: true, value };
      });
    },
    throw: error => {
      consumerDone = true;
      interruptActiveRead?.();
      return serialize(async () => {
        const errors = [error];
        await runCleanup(errors);
        return throwCollected(errors, 'Provider event consumer and retained drain both failed');
      });
    },
  };
  return {
    ...eventResult(stampedEvents, identity, { performance: context, headers: providerResult.headers }),
    finalMetadata,
  };
};
