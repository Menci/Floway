import { openAIChatCompletionsPayloadStage } from './payload-stage.ts';

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument (e.g. Azure DeepSeek returns
// `unrecognized_request_argument`). Drop the top-level field before the
// request reaches the terminal. OpenAI-native and truly OpenAI-compatible
// upstreams accept it for prefix-cache attribution, so removal only happens
// under the flag.
export const stripPromptCacheKey = openAIChatCompletionsPayloadStage('strip-prompt-cache-key', (payload, flags) => {
  if (!flags.includes('strip-prompt-cache-key') || payload.prompt_cache_key === undefined) return payload;
  const { prompt_cache_key: _stripped, ...rest } = payload;
  return rest;
});
