import type { azureUpstreamFact } from '../upstream.ts';
import { setHeader, type HttpBody, type HttpRequestFact } from '@floway-dev/http';
import type { ProviderUpstream } from '@floway-dev/provider';

type Config = ReturnType<typeof azureUpstreamFact>['config'];

export const upstreamConfig = ({ config }: ProviderUpstream): Config => config as Config;

export const prepareRequest = (
  request: HttpRequestFact,
  config: Config,
  url: string,
  body: HttpBody,
  { anthropicMessages = false, contentType = 'application/json' }: { anthropicMessages?: boolean; contentType?: string } = {},
): HttpRequestFact => {
  let headers = setHeader(request.headers, 'content-type', contentType);
  if (anthropicMessages) {
    // https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude
    headers = setHeader(setHeader(headers, 'x-api-key', config.apiKey), 'anthropic-version', '2023-06-01');
  } else {
    // https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
    headers = setHeader(headers, 'api-key', config.apiKey);
  }
  return { ...request, method: 'POST', url, headers, body };
};
