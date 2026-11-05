import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth } from './auth.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import type { FetchInit, UpstreamFetchOptions } from '@floway-dev/provider';

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
  let snapshot;
  try {
    snapshot = parseCopilotQuotaHeaders(headers, new Date());
  } catch (error) {
    console.warn(`Failed to parse Copilot quota snapshot for ${upstreamId}:`, error);
    return;
  }
  if (snapshot === null) return;
  const persist = putCopilotQuota(upstreamId, snapshot).catch((error: unknown) => {
    console.warn(`Failed to persist Copilot quota snapshot for ${upstreamId}:`, error);
  });
  waitUntil?.(persist);
};

// Token-exchange failures surface as regular OpenAI Responses so callers handle them via the same 4xx/5xx path.
const copilotFetchInternal = async (
  config: CopilotFetchConfig,
  path: string,
  init: FetchInit,
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

export const copilotFetchOpenAIChatCompletions = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/chat/completions', init, options);
export const copilotFetchOpenAIResponses = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/responses', init, options);
export const copilotFetchAnthropicMessages = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages', init, options);
export const copilotFetchAnthropicMessagesCountTokens = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages/count_tokens', init, options);
export const copilotFetchOpenAIEmbeddings = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/embeddings', init, options);
// The image endpoints advertise `/v1/...` paths and only answer there: the
// unprefixed `/images/edits` the other data-plane surfaces use returns a bare
// `404 page not found`. `/v1/images/generations` accepts JSON only, while
// `/v1/images/edits` accepts JSON references, multipart uploads, and rejects
// external image URLs with `external image URLs are not supported`.
export const copilotFetchOpenAIImagesGenerations = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/images/generations', init, options);
export const copilotFetchOpenAIImagesEdits = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/images/edits', init, options);
export const copilotFetchModels = (config: CopilotFetchConfig, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/models', init, options);
// Copilot serves decision models at the path each one advertises in
// `supported_endpoints` — `/v1/systemone` or `/v1/decisions` — and the body is
// forwarded in that model's own dialect, unchanged.
export const copilotFetchDecision = (config: CopilotFetchConfig, path: string, init: FetchInit, options: CopilotDataPlaneFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, path, init, options);
