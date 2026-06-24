import type { RequestBody } from './request-body.ts';
import { type DumpAccumulator, openDumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getCurrentColo } from '../../../runtime/runtime-info.ts';
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
  // Null when the api key has no retention configured, in which case the
  // respond layer's `ctx.dump?.X(...)` calls collapse to no-ops and
  // `ctx.dump?.finalize(response) ?? response` returns the response unchanged.
  readonly dump: DumpAccumulator | null;
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
  };
};
