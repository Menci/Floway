import { vendorStage } from './vendor-stage.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// https://platform.kimi.com/docs/api/chat
export const normalizeKimi = vendorStage('vendor-kimi', undefined, chunk => {
  const usage: unknown = chunk.usage;
  if (!isJsonObject(usage)) return chunk;
  const { cached_tokens: cached, ...rest } = usage;
  if (typeof cached !== 'number') return chunk;
  const normalized = {
    ...rest,
    prompt_tokens_details: { ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}), cached_tokens: cached },
  };
  return { ...chunk, usage: normalized as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
});
