import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

export interface RetainedDispatchLifecycle {
  clientDisconnectSignal: AbortSignal;
  backgroundScheduler: BackgroundScheduler;
}

export interface RetainedResponseLimits {
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly postDisconnectDrainTimeoutMs: number;
}

export interface RetainedResponseOptions {
  readonly backgroundScheduler: BackgroundScheduler;
  readonly clientDisconnectSignal?: AbortSignal;
  readonly onCancel?: (reason: unknown) => void;
  readonly limits?: RetainedResponseLimits;
  readonly onSettled?: () => void;
}

type RetainedResponseTimeoutKind = 'idle' | 'total' | 'post-disconnect';

// Copilotd uses a 600-second SSE idle timeout; Vekil bounds upstream work to
// one hour. Cloudflare grants waitUntil only 30 seconds after disconnect, so
// the drain leaves ten seconds for final telemetry writes.
// https://github.com/ningw42/copilotd/blob/7028cecf299d236fbf08e429774affe772f3c715/internal/sse/pump.go#L204-L301
// https://github.com/sozercan/vekil/blob/e5dca42570638e8e062523dd365a19b1d55a7729/proxy/upstream_http.go#L38-L61
export const RETAINED_RESPONSE_LIMITS: RetainedResponseLimits = {
  idleTimeoutMs: 10 * 60 * 1000,
  totalTimeoutMs: 60 * 60 * 1000,
  postDisconnectDrainTimeoutMs: 20 * 1000,
};

export class RetainedResponseTimeoutError extends Error {
  constructor(readonly kind: RetainedResponseTimeoutKind) {
    super(`Retained upstream response exceeded its ${kind} timeout`);
    this.name = 'RetainedResponseTimeoutError';
  }
}

interface RetentionChainState {
  postDisconnectDeadlineAt: number | undefined;
  deadlineError: RetainedResponseTimeoutError | undefined;
}

interface DisconnectClock {
  disconnectedAt: number | undefined;
}

const retentionChainByBody = new WeakMap<ReadableStream<Uint8Array>, RetentionChainState>();
const disconnectClockBySignal = new WeakMap<AbortSignal, DisconnectClock>();

const disconnectClockFor = (signal: AbortSignal): DisconnectClock => {
  const existing = disconnectClockBySignal.get(signal);
  if (existing !== undefined) return existing;

  const clock: DisconnectClock = { disconnectedAt: undefined };
  const markDisconnected = (): void => {
    if (clock.disconnectedAt === undefined) clock.disconnectedAt = Date.now();
  };
  disconnectClockBySignal.set(signal, clock);
  if (signal.aborted) markDisconnected();
  else signal.addEventListener('abort', markDisconnected, { once: true });
  return clock;
};

const validateLimits = (limits: RetainedResponseLimits): void => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7FFF_FFFF) {
      throw new RangeError(`Retained response ${name} must be a positive 32-bit timer value`);
    }
  }
};

const unrefTimer = (timer: unknown): void => {
  if (typeof timer !== 'object' || timer === null) return;
  const unref = Reflect.get(timer, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, timer, []);
};

export const dispatchRetainedResponse = async (
  dispatch: () => Promise<Response>,
  lifecycle?: RetainedDispatchLifecycle,
): Promise<Response> => {
  if (lifecycle === undefined) return await dispatch();
  disconnectClockFor(lifecycle.clientDisconnectSignal);
  lifecycle.clientDisconnectSignal.throwIfAborted();
  const pendingResponse = dispatch();
  lifecycle.backgroundScheduler(pendingResponse.then(() => {}, () => {}));
  return retainResponse(await pendingResponse, lifecycle);
};

export const retainUpstreamFetcher = (
  fetcher: Fetcher,
  clientDisconnectSignal: AbortSignal,
  backgroundScheduler: BackgroundScheduler,
): Fetcher => async (url, init) => await dispatchRetainedResponse(
  () => fetcher(url, init),
  { clientDisconnectSignal, backgroundScheduler },
);

export const retainResponse = (
  response: Response,
  options: RetainedResponseOptions,
): Response => {
  const limits = options.limits ?? RETAINED_RESPONSE_LIMITS;
  validateLimits(limits);
  if (response.body === null) {
    options.onSettled?.();
    return response;
  }

  const sourceBody = response.body;
  const chain = retentionChainByBody.get(sourceBody) ?? {
    postDisconnectDeadlineAt: undefined,
    deadlineError: undefined,
  };
  const disconnectClock = options.clientDisconnectSignal === undefined
    ? undefined
    : disconnectClockFor(options.clientDisconnectSignal);
  const reader = sourceBody.getReader();
  let resolveLifetime!: () => void;
  let rejectLifetime!: (error: unknown) => void;
  const lifetime = new Promise<void>((resolve, reject) => {
    resolveLifetime = resolve;
    rejectLifetime = reject;
  });

  let settled = false;
  let sourceCancelStarted = false;
  let consumerCanceled = false;
  let drainStarted = false;
  let sourceRead: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let postDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let outputState: 'open' | 'closed' | 'errored' | 'canceled' = 'open';
  let outputController!: ReadableStreamDefaultController<Uint8Array>;

  const clearTimers = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (postDisconnectTimer !== undefined) clearTimeout(postDisconnectTimer);
    idleTimer = undefined;
    totalTimer = undefined;
    postDisconnectTimer = undefined;
  };
  const closeOutput = (): void => {
    if (outputState !== 'open') return;
    outputState = 'closed';
    outputController.close();
  };
  const errorOutput = (error: unknown): void => {
    if (outputState !== 'open') return;
    outputState = 'errored';
    outputController.error(error);
  };
  const settleLifetime = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    if (options.clientDisconnectSignal !== undefined && onClientDisconnect !== undefined) {
      options.clientDisconnectSignal.removeEventListener('abort', onClientDisconnect);
    }
    try {
      options.onSettled?.();
    } catch (settlementError) {
      rejectLifetime(settlementError);
      return;
    }
    if (error === undefined) resolveLifetime();
    else rejectLifetime(error);
  };
  const cancelSource = (error: unknown): void => {
    if (sourceCancelStarted) return;
    sourceCancelStarted = true;
    try {
      void reader.cancel(error).catch(() => {});
    } catch {
      // Timeout settlement must not depend on a broken source's cleanup.
    }
  };
  const tightenPostDisconnectDeadline = (
    deadlineAt: number,
    error?: RetainedResponseTimeoutError,
  ): void => {
    if (chain.postDisconnectDeadlineAt === undefined || deadlineAt < chain.postDisconnectDeadlineAt) {
      chain.postDisconnectDeadlineAt = deadlineAt;
      chain.deadlineError = error;
    } else if (error !== undefined && chain.deadlineError === undefined) {
      chain.deadlineError = error;
    }
  };
  const stopWithTimeout = (error: RetainedResponseTimeoutError): void => {
    if (settled) return;
    tightenPostDisconnectDeadline(Date.now(), error);
    cancelSource(error);
    errorOutput(error);
    settleLifetime(error);
  };
  const armIdleTimer = (): void => {
    if (settled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopWithTimeout(new RetainedResponseTimeoutError('idle'));
    }, limits.idleTimeoutMs);
    unrefTimer(idleTimer);
  };
  const armPostDisconnectTimer = (): void => {
    if (settled || chain.postDisconnectDeadlineAt === undefined) return;
    if (postDisconnectTimer !== undefined) clearTimeout(postDisconnectTimer);
    const remaining = chain.postDisconnectDeadlineAt - Date.now();
    if (remaining <= 0) {
      const error = chain.deadlineError ?? new RetainedResponseTimeoutError('post-disconnect');
      chain.deadlineError = error;
      stopWithTimeout(error);
      return;
    }
    postDisconnectTimer = setTimeout(() => {
      const error = chain.deadlineError ?? new RetainedResponseTimeoutError('post-disconnect');
      chain.deadlineError = error;
      stopWithTimeout(error);
    }, remaining);
    unrefTimer(postDisconnectTimer);
  };
  const armPostDisconnectDeadline = (disconnectedAt: number): void => {
    tightenPostDisconnectDeadline(disconnectedAt + limits.postDisconnectDrainTimeoutMs);
    armPostDisconnectTimer();
  };

  const readOneFromSource = async (): Promise<void> => {
    try {
      const next = await reader.read();
      if (settled) return;
      if (next.done) {
        if (!consumerCanceled) closeOutput();
        settleLifetime();
        return;
      }
      armIdleTimer();
      if (!drainStarted && outputState === 'open') outputController.enqueue(next.value);
    } catch (error) {
      if (settled) return;
      errorOutput(error);
      settleLifetime(error);
    }
  };
  const readSource = (): Promise<void> => {
    if (sourceRead !== undefined) return sourceRead;
    const reading = readOneFromSource();
    sourceRead = reading;
    void reading.then(() => {
      if (sourceRead === reading) sourceRead = undefined;
    });
    return reading;
  };
  const drain = async (): Promise<void> => {
    while (!settled) await readSource();
  };
  const startDrain = (disconnectedAt: number): void => {
    armPostDisconnectDeadline(disconnectedAt);
    if (settled || drainStarted) return;
    drainStarted = true;
    void drain();
  };
  const disconnectTime = (): number => {
    if (disconnectClock?.disconnectedAt !== undefined) return disconnectClock.disconnectedAt;
    return Date.now();
  };
  const onClientDisconnect = options.clientDisconnectSignal === undefined
    ? undefined
    : (): void => {
        if (disconnectClock !== undefined && disconnectClock.disconnectedAt === undefined) {
          disconnectClock.disconnectedAt = Date.now();
        }
        armPostDisconnectDeadline(disconnectTime());
      };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
    },
    async pull() {
      await readSource();
    },
    cancel(reason) {
      consumerCanceled = true;
      outputState = 'canceled';
      try {
        options.onCancel?.(reason);
      } finally {
        startDrain(disconnectTime());
      }
    },
  });
  const retained = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  retentionChainByBody.set(body, chain);
  if (retained.body !== null) retentionChainByBody.set(retained.body, chain);

  armIdleTimer();
  totalTimer = setTimeout(() => {
    stopWithTimeout(new RetainedResponseTimeoutError('total'));
  }, limits.totalTimeoutMs);
  unrefTimer(totalTimer);
  options.backgroundScheduler(lifetime);

  if (chain.postDisconnectDeadlineAt !== undefined) armPostDisconnectTimer();
  if (options.clientDisconnectSignal?.aborted) onClientDisconnect?.();
  else if (options.clientDisconnectSignal !== undefined && onClientDisconnect !== undefined) {
    options.clientDisconnectSignal.addEventListener('abort', onClientDisconnect, { once: true });
  }

  return retained;
};
