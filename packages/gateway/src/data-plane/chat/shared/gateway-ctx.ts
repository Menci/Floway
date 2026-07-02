import type { RequestBody } from './request-body.ts';
import { type DumpAccumulator, openDumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getCurrentColo } from '../../../runtime/runtime-info.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
  // The deployment colo / region, used both as the `runtimeLocation`
  // performance-telemetry dimension and as the dial-time colo whitelist key.
  // Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  readonly currentColo: string;
  // Null when the api key has no retention configured, in which case
  // `finalizeGatewayResponse` short-circuits the dump tee and returns the
  // response untouched.
  readonly dump: DumpAccumulator | null;
  // Headers staged during request processing and written onto the
  // outbound response by `finalizeGatewayResponse`, regardless of how
  // the responder built the body.
  readonly responseHeaders: Headers;
}

// Chat-protocol ctx — `GatewayCtx` plus the request-scoped stored-items
// store. Every chat HTTP/WS entry constructs this via
// `createChatGatewayCtxFromHono` and threads it through serve → narrow →
// attempt. Passthrough endpoints (embeddings / images / completions) have
// no stored-items concept and stay on plain `GatewayCtx`.
export interface ChatGatewayCtx extends GatewayCtx {
  readonly store: StatefulResponsesStore;
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
}

export const createGatewayCtxFromHono = (c: AuthedContext, opts: CreateGatewayCtxOptions): GatewayCtx => {
  const controller = opts.downstreamAbortController ?? (opts.wantsStream ? new AbortController() : undefined);
  const apiKey = apiKeyFromContext(c);
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  const dump = openDumpAccumulator(c, opts.method ?? c.req.method, apiKey, opts.requestBody, backgroundScheduler);
  if (opts.model !== undefined) dump?.requestedModel(opts.model);
  const colo = getCurrentColo(c.req.raw);
  return {
    apiKeyId: apiKey.id,
    upstreamIds,
    abortSignal: controller?.signal,
    wantsStream: opts.wantsStream,
    downstreamAbortController: controller,
    backgroundScheduler,
    requestStartedAt: performance.now(),
    runtimeLocation: colo,
    currentColo: colo,
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

// Chat-protocol counterpart of `createGatewayCtxFromHono`. Calls the base
// factory, then attaches the stored-items store the caller chose for this
// protocol. The factory receives `ctx.apiKeyId` so every entry threads the
// same authoritative id into its store — messages / gemini / chat-completions
// pass `createNonResponsesSourceStore`; responses HTTP passes
// `apiKeyId => createResponsesHttpStore(apiKeyId, payload.store)`; responses
// WS passes `apiKeyId => session.createStore(apiKeyId, payload.store)`.
export const createChatGatewayCtxFromHono = (
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  storeFactory: (apiKeyId: string) => StatefulResponsesStore,
): ChatGatewayCtx => {
  const base = createGatewayCtxFromHono(c, opts);
  return { ...base, store: storeFactory(base.apiKeyId) };
};
