import type { OllamaUpstreamConfig } from './config.ts';
import type { Fetcher, FetchInit } from '@floway-dev/http';
import { joinBaseAndPath } from '@floway-dev/provider';

type OllamaApiPath = '/api/tags' | '/api/show' | '/api/me' | '/api/usage' | '/api/balance';

export const fetchOllamaApi = async (
  config: OllamaUpstreamConfig,
  path: OllamaApiPath,
  init: FetchInit,
  fetcher: Fetcher,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  // https://docs.ollama.com/api/authentication
  if (config.apiKey) headers.set('authorization', `Bearer ${config.apiKey}`);
  if (init.body) headers.set('content-type', 'application/json');
  return await fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers });
};
