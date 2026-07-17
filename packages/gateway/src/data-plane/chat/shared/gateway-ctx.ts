import { AffinityRequestContext } from './affinity/index.ts';
import type { RequestBody } from './request-body.ts';
import { type DumpAccumulator, openDumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { getRuntimeLocation } from '../../../runtime/runtime-info.ts';
import { ResponsesAttemptState } from '../responses/attempt-state.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
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
// UpstreamCallOptions.wrapUpstreamCall for why the interval includes proxy
// handshake time (the user waits for it too).
export const stampUpstreamCallStart = (attempt: AttemptState) =>
  <T>(dispatch: () => Promise<T>): Promise<T> => {
    attempt.upstreamCallStartedAt = performance.now();
    return dispatch();
  };

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  readonly attempt: AttemptState;
  // The deployment colo / region, used both as the `runtimeLocation`
  // performance-telemetry dimension and as the dial-time colo whitelist key.
  // Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  // Null when the api key has no retention configured, in which case
  // `finalizeGatewayResponse` short-circuits the dump tee and returns the
  // response untouched.
  readonly dump: DumpAccumulator | null;
  // Headers staged during request processing and written onto the
  // outbound response by `finalizeGatewayResponse`, regardless of how
  // the responder built the body.
  readonly responseHeaders: Headers;
}

// Chat-protocol ctx adds the affinity membrane and the Responses invocation
// state used by native Responses requests or an inner translated Responses
// call. Every chat HTTP/WS entry constructs this via
// `createChatGatewayCtxFromHono` and threads it through serve → narrow →
// attempt. Passthrough endpoints (embeddings / images / completions) have
// no stored-items concept and stay on plain `GatewayCtx`.
export interface ChatGatewayCtx extends GatewayCtx {
  readonly affinity: AffinityRequestContext;
  readonly responsesAttemptState: ResponsesAttemptState;
  readonly store?: StatefulResponsesStore;
}

export interface CreateGatewayCtxOptions {
  wantsStream: boolean;
  // WebSocket-style call sites own the AbortController (so the upgrade
  // handler can cancel mid-stream); HTTP call sites let the factory mint one
  // when wantsStream is true.
  downstreamAbortController?: AbortController;
  // Already-buffered inbound request body bytes. HTTP handlers read them
  // once via `readRequestBody` and pass them in so the dump accumulator's
  // snapshot reflects the exact bytes the handler parsed. WebSocket
  // upgrades carry no HTTP body — the WS Responses path passes the
  // per-turn JSON message bytes here so the dump captures the turn's
  // input verbatim.
  requestBody: RequestBody;
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

export const createGatewayCtxFromHono = (c: AuthedContext, opts: CreateGatewayCtxOptions): GatewayCtx => {
  const controller = opts.downstreamAbortController ?? (opts.wantsStream ? new AbortController() : undefined);
  const apiKey = apiKeyFromContext(c);
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const dump = openDumpAccumulator(c, opts.method ?? c.req.method, apiKey, opts.requestBody, opts.backgroundScheduler);
  if (opts.model !== undefined) dump?.requestedModel(opts.model);
  return {
    apiKeyId: apiKey.id,
    upstreamIds,
    abortSignal: controller?.signal,
    wantsStream: opts.wantsStream,
    downstreamAbortController: controller,
    backgroundScheduler: opts.backgroundScheduler,
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    runtimeLocation: getRuntimeLocation(c.req.raw),
    dump,
    responseHeaders: new Headers(),
  };
};

// Run the dump-accumulator's finalize tee on the outgoing Response. Every
// inbound HTTP wrapper returns its response through this seam so the dump
// pipeline applies uniformly across happy-path, error, and passthrough paths.
export const finalizeGatewayResponse = (ctx: GatewayCtx, response: Response): Response => {
  for (const [name, value] of ctx.responseHeaders) response.headers.set(name, value);
  return ctx.dump?.finalize(response) ?? response;
};

// Chat-protocol counterpart of `createGatewayCtxFromHono`. The factory
// receives the authoritative API-key id. Non-Responses sources leave the store
// absent even when translation enters a Responses attempt. Native Responses
// HTTP and WebSocket entries supply their transport-specific store factories.
export const createChatGatewayCtxFromHono = (
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  storeFactory?: (apiKeyId: string) => StatefulResponsesStore,
): ChatGatewayCtx => {
  const base = createGatewayCtxFromHono(c, opts);
  return {
    ...base,
    affinity: new AffinityRequestContext(apiKeyFromContext(c).serverSecret),
    responsesAttemptState: new ResponsesAttemptState(),
    ...(storeFactory !== undefined ? { store: storeFactory(base.apiKeyId) } : {}),
  };
};
