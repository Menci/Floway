import type { CustomAuthStyle } from '../config.ts';
import type { customUpstreamFact } from '../upstream.ts';
import { hasHeader, setHeader, type HttpBody, type HttpRequestFact } from '@floway-dev/http';
import { joinBaseAndPath, type ProviderUpstream } from '@floway-dev/provider';

type Config = ReturnType<typeof customUpstreamFact>['config'];

export const upstreamConfig = ({ config }: ProviderUpstream): Config => config as Config;

export const prepareRequest = (
  request: HttpRequestFact,
  config: Config,
  path: string,
  body: HttpBody,
  { authStyle = 'bearer', contentType = 'application/json' }: { authStyle?: CustomAuthStyle; contentType?: string } = {},
): HttpRequestFact => {
  let headers = setHeader(request.headers, 'content-type', contentType);
  const key = config.apiKey;
  if (key !== undefined) {
    if (authStyle === 'bearer') headers = setHeader(headers, 'authorization', key.map(value => `Bearer ${value}`));
    else headers = setHeader(headers, authStyle, key);
    // https://docs.anthropic.com/en/api/versioning
    if (authStyle === 'x-api-key' && !hasHeader(headers, 'anthropic-version')) {
      headers = setHeader(headers, 'anthropic-version', '2023-06-01');
    }
  }
  return { ...request, method: 'POST', url: joinBaseAndPath(config.baseUrl, path), headers, body };
};
