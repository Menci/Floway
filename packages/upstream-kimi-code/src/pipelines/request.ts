import { parseKimiCodeUpstreamConfig, type KimiCodeUpstreamConfig } from '../config.ts';
import { kimiCodeUrl } from '../fetch.ts';
import { setHeader, type HttpRequestFact } from '@floway-dev/http';
import { secret } from '@floway-dev/pipeline';
import type { UpstreamSnapshot } from '@floway-dev/upstream';

export const kimiCodeConfig = ({ kind, config }: UpstreamSnapshot): KimiCodeUpstreamConfig => {
  if (kind !== 'kimi-code') throw new TypeError(`Expected kimi-code upstream, got ${kind}`);
  return parseKimiCodeUpstreamConfig(config);
};

// Kimi directs the coding service SDK to use the Anthropic and OpenAI APIs.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
export const prepareKimiCodeRequest = (
  http: HttpRequestFact,
  upstream: UpstreamSnapshot,
  endpoint: '/chat/completions' | '/responses' | '/messages' | '/messages/count_tokens',
  body: object,
): HttpRequestFact => {
  const { region, apiKey } = kimiCodeConfig(upstream);
  const headers = setHeader(http.headers, 'authorization', secret(apiKey).map(value => `Bearer ${value}`));
  return {
    ...http,
    url: kimiCodeUrl(region, endpoint),
    method: 'POST',
    headers: setHeader(headers, 'content-type', 'application/json'),
    body: JSON.stringify(body),
  };
};
