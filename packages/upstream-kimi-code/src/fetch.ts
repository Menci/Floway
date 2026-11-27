import type { KimiCodeUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/upstream';

// Coding subscription keys use the regional coding service, independently of
// Moonshot Open Platform keys and billing.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const BASE_URLS = {
  china: 'https://api.kimi.com/coding/v1',
  overseas: 'https://api.kimi.ai/coding/v1',
} as const;

export const kimiCodeFetch = async (
  config: KimiCodeUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  for (const [name, value] of options.extraHeaders ?? []) headers.set(name, value);
  headers.set('authorization', `Bearer ${config.apiKey}`);
  if (init.body) headers.set('content-type', 'application/json');
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(BASE_URLS[config.region], path), { ...init, headers }));
};

export const readKimiCodeJson = async (response: Response, path: string): Promise<unknown> => {
  const text = await response.text();
  if (!response.ok) throw new Error(`Kimi Code ${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as unknown;
};
