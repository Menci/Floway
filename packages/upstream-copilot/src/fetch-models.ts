import { copilotIdentityHeaders, getCopilotCatalogToken, isCopilotTokenFetchError } from './auth.ts';
import type { CopilotAuth } from './config.ts';
import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels, type Fetcher } from '@floway-dev/upstream';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

// VSCode Copilot Chat tags `/models` calls with the `model-access` intent
// instead of the generic `conversation-agent` one used for generation calls,
// and omits `Content-Type` since the request has no body. Probing both header
// sets returned byte-identical bodies and policy headers, so the only
// motivation is semantic alignment with VSCode's wire shape.
//
// Reference (caozhiyuan/copilot-api uses the same split):
// https://github.com/caozhiyuan/copilot-api/blob/dc3d4aaf249d534bc66d5f1cb221ac29489b9753/src/lib/api-config.ts
const fetchCopilotCatalog = async (config: CopilotAuth, fetcher: Fetcher): Promise<Response> => {
  const credentials = await getCopilotCatalogToken(config, fetcher).catch(cause => {
    if (!isCopilotTokenFetchError(cause)) throw cause;
    return new Response(cause.body, { status: cause.status, headers: cause.headers });
  });
  if (credentials instanceof Response) return credentials;
  const headers = new Headers();
  for (const [name, value] of copilotIdentityHeaders()) headers.set(name, value);
  headers.set('authorization', `Bearer ${credentials.token}`);
  headers.set('openai-intent', 'model-access');
  headers.set('x-interaction-type', 'model-access');
  return await fetcher(`${credentials.baseUrl}/models`, { method: 'GET', headers });
};

export const fetchCopilotModels = (config: CopilotAuth, fetcher: Fetcher): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(
    () => fetchCopilotCatalog(config, fetcher),
    v => (isCopilotModelsResponse(v) ? v : null),
  );
