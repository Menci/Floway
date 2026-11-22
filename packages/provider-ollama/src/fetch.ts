import type { OllamaUpstreamConfig } from './config.ts';
import { joinBaseAndPath, type FetchInit, type Fetcher } from '@floway-dev/provider';

const ollamaFetchInternal = async (
  config: OllamaUpstreamConfig,
  path: string,
  init: FetchInit,
  fetcher: Fetcher,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return await fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers });
};

export const ollamaFetchTags = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/tags', init, fetcher);
export const ollamaFetchShow = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/show', init, fetcher);
// Account-level usage windows. Cloud-only — see usage-probe.ts for the
// endpoint's provenance and the shape it returns.
export const ollamaFetchUsage = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/usage', init, fetcher);
// Current account balance; rate-limited independently of inference.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx
export const ollamaFetchBalance = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/balance', init, fetcher);
// The account behind the API key: identity and the plan it is on. POST-only —
// the endpoint answers 405 to GET. See account-probe.ts for the body's shape.
export const ollamaFetchMe = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/me', init, fetcher);
