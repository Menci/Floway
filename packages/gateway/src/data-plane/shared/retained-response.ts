import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

// How long the gateway keeps reading an upstream response after its client has
// disconnected. Generous on purpose: an LLM generation the client abandoned may
// still have minutes of work left, and cutting it short loses the usage and
// dump records this retention exists to settle. It is a backstop against an
// upstream that never finishes, not a request deadline.
//
// Only Node can spend the whole budget. On Cloudflare the retention runs inside
// executionCtx.waitUntil, which the runtime ends on its own schedule well
// before this, so the effective window there is whatever the platform grants.
const RETAINED_DRAIN_BUDGET_MS = 15 * 60 * 1000;

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
    // The drain exists so usage and dump records settle after the client walks
    // away, not so an upstream can hold its transport open forever. An upstream
    // that stops producing without ending the stream would otherwise pin the
    // dialed socket and everything behind it for the life of the process, and
    // nothing else is watching: the ordinary teardown is the body reaching EOF
    // or being cancelled, and this drain is the only remaining reader.
    const abandon = setTimeout(() => {
      void reader.cancel(new Error(`upstream retained past ${RETAINED_DRAIN_BUDGET_MS}ms after the client disconnected`)).catch(() => {});
    }, RETAINED_DRAIN_BUDGET_MS);
    // Node keeps the process alive for a pending timer; a shutdown should not
    // wait out the budget. Workers has no unref and needs none.
    (abandon as { unref?: () => void }).unref?.();
    void drain().finally(() => clearTimeout(abandon));
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
