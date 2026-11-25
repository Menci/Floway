import { defineCopilotStage } from '../facts.ts';
import { readUsageNumber } from '../shared/read-usage-number.ts';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
// Kimi normalization is selected by the upstream model's flag.
// Reference:
// - https://platform.kimi.com/docs/api/chat
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const rewriteInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage: unknown = chunk.usage;
  if (!isJsonObject(usage)) return chunk;
  const cached = readUsageNumber(usage.cached_tokens);
  if (cached == null) return chunk;

  const { cached_tokens: _stripped, ...rest } = usage;
  const next: JsonObject = {
    ...rest,
    prompt_tokens_details: {
      ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}),
      cached_tokens: cached,
    },
  };
  return { ...chunk, usage: next as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};

export const normalizeKimi = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.normalizeKimi',
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
        yield item.ok ? { ok: true, value: rewriteInboundUsage(item.value) } : item;
      }
    });
    return { ...back, 'response.openaiChatCompletions': { kind: 'stream', stream } };
  },
});
