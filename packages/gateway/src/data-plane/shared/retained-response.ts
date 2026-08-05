import type { BackgroundScheduler } from '@floway-dev/platform';

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
