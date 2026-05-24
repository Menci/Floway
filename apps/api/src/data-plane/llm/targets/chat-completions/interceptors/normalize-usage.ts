import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../../shared/json-helpers.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';

/**
 * Normalize OpenAI-compatible upstream `usage` into the OpenAI standard shape
 * so translation and telemetry can read one contract regardless of vendor:
 *
 * 1. Cache token field names are rewritten into
 *    `prompt_tokens_details.cached_tokens` (the standard). Variants observed:
 *    - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *      (https://api-docs.deepseek.com/guides/kv_cache)
 *    - Kimi / Moonshot: flat `cached_tokens` on usage in examples
 *      (https://platform.kimi.com/docs/api/chat)
 *    The standard shape itself (already-correct upstreams) is left untouched.
 *
 * 2. Final-usage chunk position: the OpenAI spec puts the final `usage` on a
 *    `choices: []` carrier chunk
 *    (https://platform.openai.com/docs/api-reference/chat-streaming).
 *    Some upstreams have been observed to attach `usage` to the same chunk
 *    that carries the final delta and `finish_reason`. We strip `usage` from
 *    such a chunk and re-emit it on a synthesized spec-compliant carrier chunk
 *    immediately after.
 */

const VENDOR_USAGE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cached_tokens'] as const;

const extractCacheRead = (usage: JsonObject): number | null => {
  const standard = readJsonNumber(asJsonObject(usage.prompt_tokens_details)?.cached_tokens);
  if (standard != null) return standard;
  const dsHit = readJsonNumber(usage.prompt_cache_hit_tokens);
  if (dsHit != null) return dsHit;
  const kimi = readJsonNumber(usage.cached_tokens);
  if (kimi != null) return kimi;
  return null;
};

const normalizeUsage = (usage: JsonObject): JsonObject => {
  const cacheRead = extractCacheRead(usage);
  const out: JsonObject = { ...usage };
  for (const field of VENDOR_USAGE_FIELDS) delete out[field];
  if (cacheRead != null) {
    out.prompt_tokens_details = {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: cacheRead,
    };
  }
  return out;
};

const isCarrierChunk = (chunk: ChatCompletionChunk): boolean => chunk.choices.length === 0;

const splitOrNormalizeChunk = (chunk: ChatCompletionChunk): readonly ChatCompletionChunk[] => {
  const usage = asJsonObject(chunk.usage);
  if (!usage) return [chunk];

  const normalized = normalizeUsage(usage) as unknown as ChatCompletionChunk['usage'];
  if (isCarrierChunk(chunk)) return [{ ...chunk, usage: normalized }];

  // Relocate: original chunk loses its `usage`; carrier chunk gets it so
  // downstream readers see usage only on the spec-compliant `choices: []` shape.
  const { usage: _usage, ...withoutUsage } = chunk;
  return [
    withoutUsage,
    {
      id: chunk.id,
      object: chunk.object,
      created: chunk.created,
      model: chunk.model,
      choices: [],
      usage: normalized,
    },
  ];
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

        const chunks = splitOrNormalizeChunk(frame.event);
        if (chunks.length === 1 && chunks[0] === frame.event) {
          yield frame;
          continue;
        }
        for (const chunk of chunks) yield eventFrame(chunk);
      }
    })(),
  };
};
