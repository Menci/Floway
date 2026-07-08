import type { ChatCompletionsInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument (e.g. Azure DeepSeek returns
// `unrecognized_request_argument`). Drop the top-level field before the
// request reaches the terminal. OpenAI-native and truly OpenAI-compatible
// upstreams accept it for prefix-cache attribution, so removal only happens
// under the flag.
export const withPromptCacheKeyStripped: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('strip-prompt-cache-key')) return await run();
  if (ctx.payload.prompt_cache_key === undefined) return await run();
  const { prompt_cache_key: _stripped, ...rest } = ctx.payload;
  ctx.payload = rest;
  return await run();
};
