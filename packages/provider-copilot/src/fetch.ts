import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth } from './auth.ts';
import type { UpstreamFetchOptions } from '@floway-dev/provider';

export type CopilotFetchConfig = CopilotAuth;

// Token-exchange failures surface as regular Responses so callers handle them via the same 4xx/5xx path.
const copilotFetchInternal = (
  config: CopilotFetchConfig,
  path: string,
  init: RequestInit,
  options: UpstreamFetchOptions,
): Promise<Response> =>
  copilotAuthedFetch(path, init, config, {
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

export const copilotFetchChatCompletions = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/chat/completions', init, options);
export const copilotFetchResponses = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/responses', init, options);
export const copilotFetchMessages = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages', init, options);
export const copilotFetchMessagesCountTokens = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages/count_tokens', init, options);
export const copilotFetchEmbeddings = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/embeddings', init, options);
export const copilotFetchModels = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/models', init, options);
