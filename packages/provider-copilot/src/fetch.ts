import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth } from './auth.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from './quota.ts';
import type { FetchInit, UpstreamFetchOptions } from '@floway-dev/provider';

export type CopilotFetchConfig = CopilotAuth;

export const copilotFetchModels = async (
  config: CopilotFetchConfig,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const response = await copilotAuthedFetch('/models', init, config, {
    headers: options.extraHeaders,
    fetcher: options.fetcher,
  }).catch(error => {
    if (!isCopilotTokenFetchError(error)) throw error;
    return new Response(error.body, { status: error.status, headers: error.headers });
  });
  let snapshot;
  try {
    snapshot = parseCopilotQuotaHeaders(response.headers, new Date());
  } catch (error) {
    console.warn(`Failed to parse Copilot quota snapshot for ${config.id}:`, error);
    return response;
  }
  if (snapshot !== null) {
    void putCopilotQuota(config.id, snapshot).catch((error: unknown) => {
      console.warn(`Failed to persist Copilot quota snapshot for ${config.id}:`, error);
    });
  }
  return response;
};
