import type { OwnedRequestBody } from './request-body.ts';
import { retainResponse } from './retained-response.ts';
import { type DumpAccumulator, openDumpAccumulator } from '../../dump/accumulator.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

// Per-attempt performance state. Reset at the start of every
// iterateCandidates attempt so a candidate that short-circuits cannot inherit
// the prior attempt's slots. The numeric slots use `null` because a real
// timestamp of `0` would be ambiguous.
export interface AttemptState {
  upstreamCallStartedAt: number | null;
  firstOutputTokenAt: number | null;
  telemetry: PerformanceTelemetryContext | undefined;
}

// Stamps at dispatch entry — pre-dial by design. See
// UpstreamCallOptions.wrapUpstreamCall for what the interval covers.
export const stampUpstreamCallStart = (attempt: AttemptState, clientDisconnectSignal?: AbortSignal) =>
  <T>(dispatch: () => Promise<T>): Promise<T> => {
    clientDisconnectSignal?.throwIfAborted();
    attempt.upstreamCallStartedAt = performance.now();
    return dispatch();
  };

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly requestStartedAt: number;
  readonly upstreamIds: readonly string[] | null;
  readonly clientDisconnectSignal: AbortSignal;
  readonly wantsStream: boolean;
  readonly clientDisconnectController: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  readonly attempt: AttemptState;
  // The deployment colo / region, used both as the `runtimeLocation`
  // performance-telemetry dimension and as the dial-time colo whitelist key.
  // Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  // Null when the api key has no dump retention configured, in which case
  // `finalizeGatewayResponse` skips only the dump tee. Response lifetime
  // retention still applies.
  readonly dump: DumpAccumulator | null;
}

export interface CreateGatewayCtxOptions {
  wantsStream: boolean;
  // WebSocket call sites own the connection controller. HTTP call sites let
  // the factory create one and mirror the inbound Request signal into it.
  clientDisconnectController?: AbortController;
  // Already-buffered inbound request body bytes. HTTP handlers read them
  // once via `readRequestBody` and pass them in so the dump accumulator's
  // snapshot reflects the exact bytes the handler parsed. WebSocket
  // upgrades carry no HTTP body — the WS Responses path passes the
  // per-turn JSON message bytes here so the dump captures the turn's
  // input verbatim.
  requestBody: OwnedRequestBody;
  // Override the HTTP method recorded on the dump's request snapshot. The
  // WS Responses path uses `'WS'` so a dumped turn reads as
  // `WS /v1/responses` in the dashboard rather than the upgrade's `GET`.
  method?: string;
  // The model id parsed from the request payload (or from the URL on
  // Gemini's routes), stamped on the dump immediately so even an
  // outright-error turn carries model attribution. Omit only on error
  // fallback paths where payload parsing itself failed.
  model?: string;
  // Sink for every background task the ctx spawns (dump write, upstream
  // telemetry, performance recording, usage recording). Provided by the
  // call site so the correct lifetime binding is chosen: HTTP handlers
  // pass `backgroundSchedulerFromContext(c)` (the runtime's fetch-scoped
  // scheduler); the WS Responses transport builds a session-scoped
  // scheduler backed by one lifetime `waitUntil` registered while the
  // fetch handler is still active, so per-message tasks fired after the
  // 101 upgrade has returned still complete.
  backgroundScheduler: BackgroundScheduler;
}

const createRequestLinkedAbortController = (requestSignal: AbortSignal): AbortController => {
  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(requestSignal.reason);

  if (requestSignal.aborted) {
    abortFromRequest();
    return controller;
  }

  requestSignal.addEventListener('abort', abortFromRequest, { once: true });
  controller.signal.addEventListener('abort', () => {
    requestSignal.removeEventListener('abort', abortFromRequest);
  }, { once: true });
  return controller;
};

export const createGatewayCtxFromHono = (c: AuthedContext, opts: CreateGatewayCtxOptions): GatewayCtx => {
  const controller = opts.clientDisconnectController ?? createRequestLinkedAbortController(c.req.raw.signal);
  const apiKey = apiKeyFromContext(c);
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const dump = openDumpAccumulator(c, opts.method ?? c.req.method, apiKey, opts.requestBody, opts.backgroundScheduler);
  if (opts.model !== undefined) dump?.requestedModel(opts.model);
  return {
    apiKeyId: apiKey.id,
    requestStartedAt: Date.now(),
    upstreamIds,
    clientDisconnectSignal: controller.signal,
    wantsStream: opts.wantsStream,
    clientDisconnectController: controller,
    backgroundScheduler: opts.backgroundScheduler,
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    runtimeLocation: getRuntimeLocation(c.req.raw),
    dump,
  };
};

// Finalize the optional dump tee, then retain the outgoing body independently
// of its consumer. Client cancellation records the disconnect while the
// background scheduler keeps the server-side response drain alive.
export const finalizeGatewayResponse = (ctx: GatewayCtx, response: Response): Response =>
  retainResponse(
    ctx.dump?.finalize(response) ?? response,
    ctx.backgroundScheduler,
    reason => {
      if (!ctx.clientDisconnectSignal.aborted) ctx.clientDisconnectController.abort(reason);
    },
  );
