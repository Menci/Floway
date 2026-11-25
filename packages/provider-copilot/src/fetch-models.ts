import { copilotAuthedFetch, isCopilotTokenFetchError, type CopilotAuth, type createCopilotCredentials } from './auth.ts';
import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels, type Fetcher, type HttpHeaderLines, identityWrapUpstreamCall } from '@floway-dev/provider';

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
const MODELS_HEADER_OVERRIDES: HttpHeaderLines = [
  ['openai-intent', 'model-access'],
  ['x-interaction-type', 'model-access'],
  ['content-type', ''],
];

export const fetchCopilotModels = (
  config: CopilotAuth,
  fetcher: Fetcher,
  credentials?: ReturnType<typeof createCopilotCredentials>,
): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(
    async () => {
      try {
        return await copilotAuthedFetch('/models', { method: 'GET' }, config, {
          headers: MODELS_HEADER_OVERRIDES,
          fetcher,
          wrapUpstreamCall: identityWrapUpstreamCall,
        }, credentials);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        return new Response(error.body, { status: error.status, headers: error.headers });
      }
    },
    v => (isCopilotModelsResponse(v) ? v : null),
  );
