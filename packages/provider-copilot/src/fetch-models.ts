import { isCopilotTokenFetchError, type createCopilotCredentials } from './auth.ts';
import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels, type Fetcher } from '@floway-dev/provider';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

export const fetchCopilotModels = (
  config: { readonly id: string; readonly githubHost: string; readonly githubToken: string },
  fetcher: Fetcher,
  credentials: ReturnType<typeof createCopilotCredentials>,
): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(
    async () => {
      let access;
      try {
        access = await credentials.getCopilotToken(config.id, config.githubHost, config.githubToken, fetcher);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        return new Response(error.response.body === null ? null : error.body, {
          status: error.status,
          statusText: error.response.statusText,
          headers: error.headers,
        });
      }

      // VS Code attributes the bodyless catalog request to model access.
      // https://github.com/caozhiyuan/copilot-api/blob/dc3d4aaf249d534bc66d5f1cb221ac29489b9753/src/lib/api-config.ts
      const headers = new Headers(credentials.identityHeaders().map(([name, value]) => [name, value]));
      headers.set('authorization', `Bearer ${access.token}`);
      headers.set('openai-intent', 'model-access');
      headers.set('x-interaction-type', 'model-access');
      return await fetcher(`${access.baseUrl}/models`, { method: 'GET', headers });
    },
    v => (isCopilotModelsResponse(v) ? v : null),
  );
