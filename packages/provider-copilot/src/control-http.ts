import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth } from './auth.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import type { FetchInit, UpstreamFetchOptions } from '@floway-dev/provider';

export type CopilotFetchConfig = CopilotAuth;

export interface CopilotControlFetchOptions extends UpstreamFetchOptions {
  /** Extends control-call persistence beyond the response where the runtime supports it. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

// Keep any entitlement metadata returned by the catalog refresh without delaying its result.
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

// A rejected credential exchange retains its HTTP reply for catalog error diagnostics.
export const copilotFetchModels = async (
  config: CopilotFetchConfig,
  init: FetchInit,
  options: CopilotControlFetchOptions,
): Promise<Response> => {
  const response = await copilotAuthedFetch('/models', init, config, {
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
