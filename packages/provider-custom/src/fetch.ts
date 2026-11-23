import type { CustomAuthStyle, CustomUpstreamConfig } from './config.ts';
import { joinBaseAndPath, type Fetcher, type HttpHeaderLines } from '@floway-dev/provider';

// https://docs.anthropic.com/en/api/versioning
const ANTHROPIC_VERSION = '2023-06-01';

export const customAuthHeaders = (apiKey: string, style: CustomAuthStyle): HttpHeaderLines => {
  if (apiKey === '') return [];
  switch (style) {
  case 'x-api-key': return [['x-api-key', apiKey], ['anthropic-version', ANTHROPIC_VERSION]];
  // https://ai.google.dev/gemini-api/docs/api-key
  case 'x-goog-api-key': return [['x-goog-api-key', apiKey]];
  case 'bearer': return [['Authorization', `Bearer ${apiKey}`]];
  }
};

// The catalog uses its own auth style because its endpoint has no protocol identity.
export const customFetchModels = (config: CustomUpstreamConfig, fetcher: Fetcher, pageToken?: string): Promise<Response> => {
  const path = config.modelsFetch.endpoint ?? '/v1/models';
  const target = pageToken === undefined ? path : `${path}${path.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}`;
  return fetcher(joinBaseAndPath(config.baseUrl, target), {
    method: 'GET',
    headers: customAuthHeaders(config.apiKey, config.modelsFetch.authStyle).map(([name, value]): [string, string] => [name, value]),
  });
};
