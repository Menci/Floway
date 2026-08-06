import type { OwnedRequestBody } from './request-body.ts';
import { retainResponse, RETAINED_RESPONSE_LIMITS } from './retained-response.ts';
import { type DumpAccumulator, openDumpAccumulator } from '../../dump/accumulator.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import type { ApiKey } from '../../repo/types.ts';
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
  readonly executionSignal: AbortSignal;
  readonly executionController: AbortController;
  readonly finishExecution: () => void;
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
  // WebSocket turns supply this so a server-owned connection policy can stop
  // execution without changing ordinary client-disconnect semantics.
  executionController?: AbortController;
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

export type RegisterGatewayCtx = <Ctx extends GatewayCtx>(ctx: Ctx) => Ctx;

type GatewayResponseOperation = (registerCtx: RegisterGatewayCtx) => Promise<Response>;
type GatewayResponseRecovery = (
  error: unknown,
  ctx: GatewayCtx | undefined,
  registerCtx: RegisterGatewayCtx,
) => Promise<Response>;

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

export const createGatewayCtxFromHono = <Extension extends object = Record<never, never>>(
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  extensionFactory?: (construction: { readonly apiKey: ApiKey; readonly requestStartedAt: number }) => Extension,
): GatewayCtx & Extension => {
  const apiKey = apiKeyFromContext(c);
  const requestStartedAt = Date.now();
  // Extension construction is part of the same transaction as the base
  // context. Chat affinity and item stores can reject persisted state, so all
  // of them must exist before the first lifecycle timer is armed.
  const extension = extensionFactory === undefined
    ? {} as Extension
    : { ...extensionFactory({ apiKey, requestStartedAt }) };
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const runtimeLocation = getRuntimeLocation(c.req.raw);
  const dump = openDumpAccumulator(c, opts.method ?? c.req.method, apiKey, opts.requestBody, opts.backgroundScheduler);
  if (opts.model !== undefined) dump?.requestedModel(opts.model);

  const controller = opts.clientDisconnectController ?? createRequestLinkedAbortController(c.req.raw.signal);
  const executionController = opts.executionController ?? new AbortController();
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let executionFinished = false;
  const executionTimer = setTimeout(() => {
    executionController.abort(new Error('Gateway upstream execution exceeded one hour'));
  }, RETAINED_RESPONSE_LIMITS.totalTimeoutMs);
  unrefTimer(executionTimer);
  const scheduleDisconnectDeadline = (): void => {
    if (executionFinished || disconnectTimer !== undefined || executionController.signal.aborted) return;
    disconnectTimer = setTimeout(() => {
      executionController.abort(new Error('Gateway upstream drain exceeded the post-disconnect deadline'));
    }, RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs);
    unrefTimer(disconnectTimer);
  };
  const finishExecution = (): void => {
    if (executionFinished) return;
    executionFinished = true;
    clearTimeout(executionTimer);
    if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
    controller.signal.removeEventListener('abort', scheduleDisconnectDeadline);
  };
  if (controller.signal.aborted) scheduleDisconnectDeadline();
  else controller.signal.addEventListener('abort', scheduleDisconnectDeadline, { once: true });
  return {
    ...extension,
    apiKeyId: apiKey.id,
    requestStartedAt,
    upstreamIds,
    clientDisconnectSignal: controller.signal,
    wantsStream: opts.wantsStream,
    clientDisconnectController: controller,
    executionSignal: executionController.signal,
    executionController,
    finishExecution,
    backgroundScheduler: opts.backgroundScheduler,
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    runtimeLocation,
    dump,
  };
};

// Owns the only response finalization point for an HTTP operation. A context
// is registered immediately after its transactional construction; normal and
// recovered responses then pass through the same finalizer exactly once.
export const runGatewayResponse = async (
  operation: GatewayResponseOperation,
  recover: GatewayResponseRecovery,
): Promise<Response> => {
  let ctx: GatewayCtx | undefined;
  const registerCtx: RegisterGatewayCtx = candidate => {
    if (ctx !== undefined) {
      candidate.finishExecution();
      throw new Error('Gateway response operation registered more than one context');
    }
    ctx = candidate;
    return candidate;
  };

  let response: Response;
  try {
    response = await operation(registerCtx);
  } catch (error) {
    try {
      response = await recover(error, ctx, registerCtx);
    } catch (recoveryError) {
      ctx?.finishExecution();
      throw recoveryError;
    }
  }
  if (ctx === undefined) return response;
  try {
    return finalizeGatewayResponse(ctx, response);
  } catch (error) {
    ctx.finishExecution();
    throw error;
  }
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
    RETAINED_RESPONSE_LIMITS,
    ctx.finishExecution,
  );

const unrefTimer = (timer: unknown): void => {
  if (typeof timer !== 'object' || timer === null) return;
  const unref = Reflect.get(timer, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, timer, []);
};
