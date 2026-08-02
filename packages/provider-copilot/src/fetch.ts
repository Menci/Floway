import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth } from './auth.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import type { UpstreamFetchOptions } from '@floway-dev/provider';

export type CopilotFetchConfig = CopilotAuth;

export interface CopilotDataPlaneFetchOptions extends UpstreamFetchOptions {
  /** Extends the runtime past the response so the quota persist below
   *  survives on workerd, which cancels orphan promises the moment the client
   *  response is sent. The catalog fetch threads none: a `/models` response
   *  carries no quota headers, so nothing is ever scheduled on that path. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

// Every Copilot data-plane response carries the seat's entitlement in
// `x-quota-snapshot-*`, so this funnel — the one place all of them pass
// through — is where the snapshot gets harvested. Streaming included: the
// headers land ahead of the first SSE byte.
//
// Best-effort by construction. The response is already the caller's to relay,
// and a snapshot is a strictly better-than-nothing dashboard read: a CAS loss
// to a concurrent state write, or a storage blip, must not surface on the hot
// path. A response with no quota headers (every 4xx we have observed, plus
// `/models`) leaves the persisted snapshot alone rather than erasing it.
const captureQuotaFireAndForget = (
  upstreamId: string,
  headers: Headers,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void => {
  const snapshot = parseCopilotQuotaHeaders(headers, new Date());
  if (snapshot === null) return;
  const persist = putCopilotQuota(upstreamId, snapshot).catch((error: unknown) => {
    console.warn(`Failed to persist Copilot quota snapshot for ${upstreamId}:`, error);
  });
  waitUntil?.(persist);
};

// Token-exchange failures surface as regular Responses so callers handle them via the same 4xx/5xx path.
const copilotFetchInternal = async (
  config: CopilotFetchConfig,
  path: string,
  init: RequestInit,
  options: CopilotDataPlaneFetchOptions,
): Promise<Response> => {
  const response = await copilotAuthedFetch(path, init, config, {
    headers: options.extraHeaders,
    fetcher: options.fetcher,
    wrapUpstreamCall: options.wrapUpstreamCall,
  }).catch(error => {
    if (!isCopilotTokenFetchError(error)) throw error;
    return new Response(error.body, {
      status: error.status,
      headers: new Headers(error.headers),
    });
  });
  captureQuotaFireAndForget(config.id, response.headers, options.waitUntil);
  return response;
};

export const copilotFetchChatCompletions = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/chat/completions', init, options);
export const copilotFetchResponses = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/responses', init, options);
export const copilotFetchMessages = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages', init, options);
export const copilotFetchMessagesCountTokens = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages/count_tokens', init, options);
export const copilotFetchEmbeddings = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/embeddings', init, options);
export const copilotFetchModels = (config: CopilotFetchConfig, init: RequestInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/models', init, options);
