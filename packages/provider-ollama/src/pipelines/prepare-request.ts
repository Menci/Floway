import type { ollamaUpstreamFact } from '../upstream.ts';
import { setHeader, type HttpBody, type HttpRequestFact } from '@floway-dev/http';
import { joinBaseAndPath, type ProviderUpstream } from '@floway-dev/provider';

type Config = ReturnType<typeof ollamaUpstreamFact>['config'];

export const upstreamConfig = ({ config }: ProviderUpstream): Config => config as Config;

export const prepareRequest = (
  request: HttpRequestFact,
  config: Config,
  path: string,
  body: HttpBody,
  contentType = 'application/json',
): HttpRequestFact => {
  let headers = setHeader(request.headers, 'content-type', contentType);
  // https://docs.ollama.com/api/authentication
  if (config.apiKey !== undefined) {
    const bearer = config.apiKey.map(value => `Bearer ${value}`);
    headers = setHeader(headers, 'authorization', bearer);
  }
  return { ...request, method: 'POST', url: joinBaseAndPath(config.baseUrl, path), headers, body };
};
