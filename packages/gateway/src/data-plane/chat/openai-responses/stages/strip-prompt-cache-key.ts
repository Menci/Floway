import { responsesPayloadStage } from './facts.ts';

// Azure accepts a version-specific subset of the OpenAI request fields.
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference
export const stripPromptCacheKey = responsesPayloadStage('stripPromptCacheKey', (payload, facts) => {
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('strip-prompt-cache-key')) return payload;
  if (payload.prompt_cache_key === undefined) return payload;
  const { prompt_cache_key: _stripped, ...rest } = payload;
  return rest;
});
