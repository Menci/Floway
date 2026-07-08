import type { ResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument (e.g. Azure DeepSeek). Drop the top-level field before the
// request reaches the terminal. OpenAI-native and truly OpenAI-compatible
// Responses upstreams accept it for prefix-cache attribution, so removal only
// happens under the flag.
export const withPromptCacheKeyStripped: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('strip-prompt-cache-key')) return await run();
  if (ctx.payload.prompt_cache_key === undefined) return await run();
  const { prompt_cache_key: _stripped, ...rest } = ctx.payload;
  ctx.payload = rest;
  return await run();
};
