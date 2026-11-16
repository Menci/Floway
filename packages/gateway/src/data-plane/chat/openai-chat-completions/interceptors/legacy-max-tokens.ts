import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Some compatible targets only read the legacy cap. Rename rather than duplicate
// it: other upstreams reject requests that carry both spellings.
// https://github.com/ollama/ollama/blob/c1db5f9/openai/openai.go
export const withLegacyMaxTokens: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiChatCompletions') return await run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('openai-chat-completions-legacy-max-tokens')) return await run();
  if (ctx.payload.max_completion_tokens === undefined) return await run();
  const { max_completion_tokens, ...rest } = ctx.payload;
  ctx.payload = { ...rest, max_tokens: max_completion_tokens };
  return await run();
};
