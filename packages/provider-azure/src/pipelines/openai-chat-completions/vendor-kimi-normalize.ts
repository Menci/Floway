import { factSpace } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

// https://platform.kimi.com/docs/api/chat
export const normalizeKimi = defineStage({
  name: 'azure.openaiChatCompletions.normalize-kimi',
  through: {
    request: { needs: ['provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back['response.openaiChatCompletions'];
    if (!facts['provider.model'].enabledFlags.includes('vendor-kimi') || outcome.kind !== 'stream') return back;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const value = normalizeUsage(item.value);
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { ...back, 'response.openaiChatCompletions': { ...outcome, stream } };
  },
});

const normalizeUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const raw: unknown = chunk.usage;
  if (!isJsonObject(raw)) return chunk;
  const { cached_tokens: cached, ...rest } = raw;
  if (typeof cached !== 'number') return chunk;
  const details = rest.prompt_tokens_details;
  const usage = { ...rest, prompt_tokens_details: { ...(isJsonObject(details) ? details : {}), cached_tokens: cached } };
  return { ...chunk, usage: usage as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};
