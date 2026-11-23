import type { CopilotModelsResponse } from './types.ts';
import { fetchUpstreamModels } from '@floway-dev/provider';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

export const fetchCopilotModels = (dispatch: () => Promise<Response>): Promise<CopilotModelsResponse> =>
  fetchUpstreamModels(dispatch, value => isCopilotModelsResponse(value) ? value : null);
