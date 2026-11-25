import { isCopilotTokenFetchError, type createCopilotCredentials } from './auth.ts';
import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels, ProviderModelsUnavailableError, type ProviderServices } from '@floway-dev/provider';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

export const fetchCopilotModels = async (
  config: { readonly id: string; readonly githubHost: string; readonly githubToken: string },
  fetcher: ReturnType<ProviderServices['fetcher']>,
  credentials: ReturnType<typeof createCopilotCredentials>,
): Promise<CopilotModelsResponse> => {
  const access = await credentials.getCopilotToken(config.id, config.githubHost, config.githubToken, fetcher);
  let response: Response;
  if (!access.ok) {
    const { error } = access;
    if (!isCopilotTokenFetchError(error)) {
      throw new ProviderModelsUnavailableError(null, error.kind === 'transport' ? error.error.cause : new Error(error.message));
    }
    response = new Response(error.response.body === null ? null : error.body, {
      status: error.status,
      statusText: error.response.statusText,
      headers: error.headers,
    });
  } else {
    // VS Code attributes the bodyless catalog request to model access.
    // https://github.com/caozhiyuan/copilot-api/blob/dc3d4aaf249d534bc66d5f1cb221ac29489b9753/src/lib/api-config.ts
    const headers = new Headers(credentials.identityHeaders().map(([name, value]) => [name, value]));
    headers.set('authorization', `Bearer ${access.value.token}`);
    headers.set('openai-intent', 'model-access');
    headers.set('x-interaction-type', 'model-access');
    const fetched = await fetcher(`${access.value.baseUrl}/models`, { method: 'GET', headers });
    if (!fetched.ok) throw new ProviderModelsUnavailableError(null, fetched.error.cause);
    response = fetched.value;
  }
  return await fetchUpstreamModels(
    async () => response,
    v => (isCopilotModelsResponse(v) ? v : null),
  );
};
