import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import { asJsonObject } from '../../../../shared/json-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';

// Spec-compliant OpenAI Chat Completions usage chunk shape. The OpenAI spec puts the
// final `usage` on a `choices: []` carrier chunk
// (https://platform.openai.com/docs/api-reference/chat-streaming). Some
// upstreams have been observed to attach `usage` to the same chunk that
// carries the final delta and `finish_reason`. We strip `usage` from such a
// chunk and re-emit it on a synthesized spec-compliant carrier chunk
// immediately after, so downstream consumers can rely on the standard shape.
//
// Vendor-specific cache-token field rewrites (DeepSeek
// `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, Kimi
// `cached_tokens`) live on each vendor's own `vendor-<X>-normalize`
// interceptor and run before this one on the response path, so by the time
// the chunk reaches us its `usage.prompt_tokens_details.cached_tokens` is
// already in the OpenAI standard shape.

export const withUsageNormalized: OpenAIChatCompletionsInterceptor = async (_ctx, _gatewayCtx, run) => {
  const result = await run();
  if (result.type !== 'events') return result;
  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }

        const chunk = frame.event;
        const usage = asJsonObject(chunk.usage);
        if (!usage || chunk.choices.length === 0) {
          yield frame;
          continue;
        }
        const { usage: chunkUsage, ...withoutUsage } = chunk;
        yield eventFrame(withoutUsage);
        yield eventFrame({ ...withoutUsage, choices: [], usage: chunkUsage });
      }
    })(),
  };
};
