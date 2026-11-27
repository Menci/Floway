import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const compactGenerationPayload = ({ prompt_cache_options, ...payload }: CanonicalOpenAIResponsesCompactPayload): CanonicalOpenAIResponsesPayload => ({
  ...payload,
  ...(prompt_cache_options == null ? {} : { prompt_cache_options }),
});
