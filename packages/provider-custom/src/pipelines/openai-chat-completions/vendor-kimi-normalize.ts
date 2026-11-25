import { factSpace, move, transform } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'provider.model' | 'response.openaiChatCompletions'>>();

// Kimi reports cached prompt tokens as a flat usage field.
// https://platform.kimi.com/docs/api/chat
export const normalizeKimi = defineStage({
  name: 'custom.openaiChatCompletions.normalizeKimi',
  through: {
    request: { needs: ['provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  execute: transform(scope => {
    let enabled: boolean;
    return {
      request: facts => {
        enabled = facts['provider.model'].enabledFlags.includes('vendor-kimi');
        return facts;
      },
      response: back => {
        const outcome = back['response.openaiChatCompletions'];
        if (!enabled || outcome.kind !== 'stream') return back;
        const stream = scope.wrapStream(outcome.stream, async function* (source) {
          for await (const item of source) {
            if (!item.ok) {
              yield item;
              continue;
            }
            const value = rewriteInboundUsage(item.value);
            yield value === item.value ? item : { ok: true, value };
          }
        });
        return { ...back, 'response.openaiChatCompletions': move({ kind: 'stream', stream }) };
      },
    };
  }),
});

const rewriteInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const wireUsage: unknown = chunk.usage;
  if (!isJsonObject(wireUsage)) return chunk;
  const { cached_tokens: cached, ...rest } = wireUsage;
  if (typeof cached !== 'number') return chunk;
  const usage = {
    ...rest,
    prompt_tokens_details: {
      ...(isJsonObject(rest.prompt_tokens_details) ? rest.prompt_tokens_details : {}),
      cached_tokens: cached,
    },
  };
  return { ...chunk, usage: usage as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};
