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

class RetainedResponseTimeoutError extends Error {
  constructor(kind: 'idle' | 'total' | 'post-disconnect') {
    super(`Retained upstream response exceeded its ${kind} timeout`);
    this.name = 'RetainedResponseTimeoutError';
  }
}

export const dispatchRetainedResponse = async (
  dispatch: () => Promise<Response>,
  lifecycle?: RetainedDispatchLifecycle,
): Promise<Response> => {
  if (lifecycle === undefined) return await dispatch();
  lifecycle.clientDisconnectSignal.throwIfAborted();
  const pendingResponse = dispatch();
  lifecycle.backgroundScheduler(pendingResponse.then(() => {}, () => {}));
  return retainResponse(await pendingResponse, lifecycle.backgroundScheduler);
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
  backgroundScheduler: BackgroundScheduler,
  onCancel?: (reason: unknown) => void,
  limits: RetainedResponseLimits = RETAINED_RESPONSE_LIMITS,
  onSettled?: () => void,
): Response => {
  if (response.body === null) {
    onSettled?.();
    return response;
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7FFF_FFFF) {
      throw new RangeError(`Retained response ${name} must be a positive 32-bit timer value`);
    }
  }

  const reader = response.body.getReader();
  const startedAt = Date.now();
  let resolveLifetime!: () => void;
  let rejectLifetime!: (error: unknown) => void;
  const lifetime = new Promise<void>((resolve, reject) => {
    resolveLifetime = resolve;
    rejectLifetime = reject;
  });
  let settled = false;
  let consumerCanceled = false;
  let currentPull: Promise<void> | undefined;
  let drainStarted = false;
  let postDisconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelSource = (error: unknown): void => {
    try {
      void reader.cancel(error).catch(() => {});
    } catch {
      // The timeout owns settlement even when a broken source rejects cleanup.
    }
  };

  const settleLifetime = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (postDisconnectTimer !== undefined) clearTimeout(postDisconnectTimer);
    onSettled?.();
    if (error === undefined) resolveLifetime();
    else rejectLifetime(error);
  };
  const readSource = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const totalRemaining = limits.totalTimeoutMs - (Date.now() - startedAt);
    if (totalRemaining <= 0) throw new RetainedResponseTimeoutError('total');
    const timeoutMs = Math.min(limits.idleTimeoutMs, totalRemaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const kind = totalRemaining <= limits.idleTimeoutMs ? 'total' : 'idle';
            const error = new RetainedResponseTimeoutError(kind);
            cancelSource(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const drain = async (): Promise<void> => {
    try {
      await currentPull;
      while (!(await readSource()).done) {}
      settleLifetime();
    } catch (error) {
      settleLifetime(error);
    }
  };
  const startDrain = (): void => {
    if (drainStarted) return;
    drainStarted = true;
    postDisconnectTimer = setTimeout(() => {
      const error = new RetainedResponseTimeoutError('post-disconnect');
      cancelSource(error);
      settleLifetime();
    }, limits.postDisconnectDrainTimeoutMs);
    void drain();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const pull = (async () => {
        try {
          const next = await readSource();
          if (consumerCanceled) return;
          if (next.done) {
            controller.close();
            settleLifetime();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          settleLifetime(error);
          if (!consumerCanceled) controller.error(error);
        }
      })();
      currentPull = pull;
      await pull;
      if (currentPull === pull) currentPull = undefined;
    },
    cancel(reason) {
      consumerCanceled = true;
      onCancel?.(reason);
      startDrain();
    },
  });
  backgroundScheduler(lifetime);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
