import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

export interface RetainedDispatchLifecycle {
  clientDisconnectSignal: AbortSignal;
  backgroundScheduler: BackgroundScheduler;
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
): Response => {
  if (response.body === null) return response;

  const reader = response.body.getReader();
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

  const settleLifetime = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (error === undefined) resolveLifetime();
    else rejectLifetime(error);
  };
  const drain = async (): Promise<void> => {
    try {
      await currentPull;
      while (!(await reader.read()).done) {}
      settleLifetime();
    } catch (error) {
      settleLifetime(error);
    }
  };
  const startDrain = (): void => {
    if (drainStarted) return;
    drainStarted = true;
    void drain();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const pull = (async () => {
        try {
          const next = await reader.read();
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
