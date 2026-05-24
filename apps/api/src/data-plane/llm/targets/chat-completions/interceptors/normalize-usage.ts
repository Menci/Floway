import { asJsonObject } from '../../../../../shared/json-helpers.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';

/**
 * Spec-compliant Chat Completions usage chunk shape. The OpenAI spec puts the
 * final `usage` on a `choices: []` carrier chunk
 * (https://platform.openai.com/docs/api-reference/chat-streaming). Some
 * upstreams have been observed to attach `usage` to the same chunk that
 * carries the final delta and `finish_reason`. We strip `usage` from such a
 * chunk and re-emit it on a synthesized spec-compliant carrier chunk
 * immediately after, so downstream consumers can rely on the standard shape.
 *
 * Vendor-specific cache-token field rewrites (DeepSeek
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, Kimi
 * `cached_tokens`) live on each vendor's own `vendor-<X>-normalize`
 * interceptor and run before this one on the response path, so by the time
 * the chunk reaches us its `usage.prompt_tokens_details.cached_tokens` is
 * already in the OpenAI standard shape.
 */

const isCarrierChunk = (chunk: ChatCompletionChunk): boolean => chunk.choices.length === 0;

const relocateUsageChunk = (chunk: ChatCompletionChunk): readonly ChatCompletionChunk[] => {
  const usage = asJsonObject(chunk.usage);
  if (!usage) return [chunk];
  if (isCarrierChunk(chunk)) return [chunk];

  // Relocate: original chunk loses its `usage`; carrier chunk gets it so
  // downstream readers see usage only on the spec-compliant `choices: []` shape.
  const { usage: chunkUsage, ...withoutUsage } = chunk;
  return [withoutUsage, { ...withoutUsage, choices: [], usage: chunkUsage }];
};

export const withUsageNormalized: ChatCompletionsInterceptor = async (_ctx, _request, run) => {
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

        const chunks = relocateUsageChunk(frame.event);
        if (chunks.length === 1 && chunks[0] === frame.event) {
          yield frame;
          continue;
        }
        for (const chunk of chunks) yield eventFrame(chunk);
      }
    })(),
  };
};
