import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import { asJsonObject } from '../../../../shared/json-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

// Standard usage belongs on a final choices: [] carrier. Body snapshots are
// moved to carriers here; the responder retains only the latest at termination.
// https://platform.openai.com/docs/api-reference/chat-streaming
// Explicit vLLM continuous usage preserves cumulative statistics on choice chunks.
// https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/serve/utils/api_utils.py#L289-L301
//
// Vendor-specific cache-token field rewrites (DeepSeek
// `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, Kimi
// `cached_tokens`) live on each vendor's own `vendor-<X>-normalize`
// interceptor and run before this one on the response path, so by the time
// the chunk reaches us its `usage.prompt_tokens_details.cached_tokens` is
// already in the OpenAI standard shape.

export const withUsageNormalized: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  const result = await run();
  if (result.type !== 'events') return result;
  const streamOptions = ctx.payload.stream_options as OpenAIChatCompletionsStreamOptionsEx | undefined;
  if (streamOptions?.include_usage === true && streamOptions.continuous_usage_stats === true) return result;
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
