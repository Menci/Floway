import { jsonRequest, ollamaDial } from '../dial.ts';
import { formatOpenAIError } from '../errors.ts';

// https://developers.openai.com/api/reference/resources/responses/methods/compact
export const dial = ollamaDial('openaiResponsesCompact', (body, model) => {
  const { input, instructions, previous_response_id, prompt_cache_key, prompt_cache_options, prompt_cache_retention, service_tier } = body;
  return jsonRequest('/v1/responses/compact', {
    model: model.upstreamModelId, input, instructions, previous_response_id, prompt_cache_key, prompt_cache_options, prompt_cache_retention, service_tier,
  });
}, formatOpenAIError);
