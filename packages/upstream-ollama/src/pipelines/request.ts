import { parseOllamaUpstreamConfig } from '../config.ts';
import type { OllamaProbeTarget } from '../service.ts';
import { filterHeaders, setHeader, type HttpRequestFact } from '@floway-dev/http';
import { secret } from '@floway-dev/pipeline';
import { joinBaseAndPath, type UpstreamSnapshot } from '@floway-dev/upstream';

export const ollamaTarget = ({ id, kind, config }: UpstreamSnapshot): OllamaProbeTarget => {
  if (kind !== 'ollama') throw new Error(`Expected Ollama upstream, got ${kind}`);
  return { id, config: parseOllamaUpstreamConfig(config) };
};

export const dialRequest = (http: HttpRequestFact, upstream: UpstreamSnapshot, path: string, body: string | Uint8Array, contentType: string, anthropic = false): HttpRequestFact => {
  const { config } = ollamaTarget(upstream);
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
  let headers = filterHeaders(http.headers, name => anthropic && name === 'anthropic-beta');
  headers = setHeader(headers, 'content-type', contentType);
  if (config.apiKey !== undefined) headers = setHeader(headers, 'authorization', secret(`Bearer ${config.apiKey}`));
  return { ...http, url: joinBaseAndPath(config.baseUrl, path), method: 'POST', headers, body };
};

export const dialJson = (http: HttpRequestFact, upstream: UpstreamSnapshot, path: string, body: object, anthropic = false): HttpRequestFact =>
  dialRequest(http, upstream, path, JSON.stringify(body), 'application/json', anthropic);
