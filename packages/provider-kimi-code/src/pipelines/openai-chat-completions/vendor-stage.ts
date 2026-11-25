import { defineStage } from '../facts.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type VendorFlag = 'vendor-deepseek' | 'vendor-qwen' | 'vendor-kimi';

export const vendorStage = (
  flag: VendorFlag,
  request?: (payload: OpenAIChatCompletionsPayloadEx) => OpenAIChatCompletionsPayloadEx,
  response?: (event: OpenAIChatCompletionsStreamEvent) => OpenAIChatCompletionsStreamEvent,
) => defineStage({
  name: `kimi-code.openaiChatCompletions.${flag}-normalize`,
  through: {
    request: { needs: ['request.openaiChatCompletions', 'provider.model'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts['provider.model'].enabledFlags.includes(flag)) return await scope.next(facts);
    const payload = facts['request.openaiChatCompletions'];
    const shaped = request === undefined ? payload : request(payload);
    const answer = await scope.next(shaped === payload ? facts : { ...facts, 'request.openaiChatCompletions': shaped });
    const outcome = answer['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream' || response === undefined) return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const value = response(item.value);
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { ...answer, 'response.openaiChatCompletions': { kind: 'stream', stream } };
  },
});
